import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  FEEDBACK_OPEN_SUBMISSION_LIMIT,
  FEEDBACK_TERMINAL_STATUSES,
  type AdminFeedbackListQuery,
  type CreateFeedbackRequest,
  type FeedbackMessageAuthorSide,
  type UpdateFeedbackStatusRequest,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  feedback,
  feedbackMessages,
  users,
  type FeedbackMessageRow,
  type FeedbackRow,
  type NewFeedbackRow,
  type UserRow,
} from '../schema';

export interface AdminFeedbackRow extends FeedbackRow {
  submitter: Pick<UserRow, 'id' | 'username' | 'email'>;
  /** Thread state for the helpdesk inbox (#1406 W3); never a message body. */
  unreadCount: number;
  messageCount: number;
  lastMessageAt: Date | null;
  lastAuthorSide: FeedbackMessageAuthorSide | null;
}

/**
 * Escape the `LIKE` metacharacters before an operator's search text becomes a
 * pattern. Without this a query of `%` matches the entire queue and `_` matches
 * any single character — the operator typed a literal, so they get a literal.
 * Backslash is Postgres's default `LIKE` escape, so no `ESCAPE` clause is
 * needed; it is escaped first so it cannot double-escape the two that follow.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface MyFeedbackRow extends FeedbackRow {
  unreadReplyCount: number;
}

/** Parent context returned with an admin-authored message for recipient routing. */
export interface AdminFeedbackMessageWrite {
  row: FeedbackMessageRow;
  submitterUserId: string;
  deletedByUserAt: Date | null;
}

/** A status write distinguishes a real transition from an idempotent retry. */
export interface FeedbackStatusWrite {
  row: FeedbackRow;
  changed: boolean;
}

export interface FeedbackThreadPage {
  thread: { id: string; unreadCount: number };
  rows: FeedbackMessageRow[];
  nextCursor: string | null;
}

export interface FeedbackArchiveMutation {
  row: FeedbackRow;
  /** False only when the requested archive state was already stored. */
  changed: boolean;
}

/**
 * Thread read outcomes. `not_found` covers both a missing submission and one
 * owned by another user — ownership is part of the parent SELECT, so the two are
 * indistinguishable. `invalid_cursor` is only ever reachable *after* that gate,
 * so answering it distinctly cannot reveal anything about a foreign thread.
 */
export type FeedbackThreadLookup =
  | { status: 'ok'; page: FeedbackThreadPage }
  | { status: 'not_found' }
  | { status: 'invalid_cursor' };

/** Persistence seam shared by client capture and the owner-only triage queue. */
export interface FeedbackRepository {
  /** Returns null when the caller already has the maximum number of open rows. */
  create(userId: string, input: CreateFeedbackRequest): Promise<FeedbackRow | null>;
  /** Caller ownership is part of the query and cannot be widened by HTTP input. */
  listMine(userId: string): Promise<MyFeedbackRow[]>;
  /** Idempotent caller-owned tombstone; returns null for absent or foreign rows. */
  deleteMine(userId: string, id: string, at: Date): Promise<FeedbackRow | null>;
  /** Every submitter method scopes the parent row by both id and owner in SQL. */
  getThreadForSubmitter(
    userId: string,
    id: string,
    params: { cursor?: string; limit: number },
  ): Promise<FeedbackThreadLookup>;
  getThreadForAdmin(
    id: string,
    params: { cursor?: string; limit: number },
  ): Promise<FeedbackThreadLookup>;
  createMessageForSubmitter(
    userId: string,
    id: string,
    body: string,
  ): Promise<FeedbackMessageRow | null>;
  createMessageForAdmin(
    adminUserId: string,
    id: string,
    body: string,
  ): Promise<AdminFeedbackMessageWrite | null>;
  markReadForSubmitter(userId: string, id: string): Promise<boolean>;
  markReadForAdmin(id: string): Promise<boolean>;
  listForAdmin(
    params: AdminFeedbackListQuery,
  ): Promise<{ rows: AdminFeedbackRow[]; total: number }>;
  /**
   * One submission by id for the helpdesk, unconstrained by the inbox filters
   * so a shared thread link resolves for any operator. Null when it is gone.
   */
  getForAdmin(id: string): Promise<AdminFeedbackRow | null>;
  setStatus(id: string, input: UpdateFeedbackStatusRequest): Promise<FeedbackStatusWrite | null>;
  /** Idempotently set the admin-only workspace archive state for any submission. */
  setArchived(id: string, archived: boolean, at: Date): Promise<FeedbackArchiveMutation | null>;
}

export function createFeedbackRepository(
  db: Database,
  now: () => Date = () => new Date(),
): FeedbackRepository {
  /**
   * Submitter-rail parent scoping. Ownership is only half of it: a submission the
   * owner has tombstoned (#1400) has left their rail entirely, so it must read as
   * missing on the thread endpoints too rather than merely dropping out of
   * `/feedback/mine` — otherwise a submitter could still read and answer a
   * conversation they deleted, in replies they would never see again. The admin
   * rail passes no user id and so keeps seeing tombstoned rows, which is exactly
   * the audit trail the tombstone exists to preserve.
   */
  function submitterScope(submitterUserId?: string): SQL | undefined {
    return submitterUserId
      ? and(eq(feedback.userId, submitterUserId), isNull(feedback.deletedByUserAt))
      : undefined;
  }

  /**
   * Resolve a viewer-relative thread head and page. Submitter ownership, when
   * supplied, is part of the parent SELECT; a missing and another user's id are
   * therefore indistinguishable before any message row is read.
   */
  async function getThread(
    id: string,
    viewerSide: FeedbackMessageAuthorSide,
    params: { cursor?: string; limit: number },
    submitterUserId?: string,
  ): Promise<FeedbackThreadLookup> {
    const lastReadAtColumn =
      viewerSide === 'submitter' ? feedback.submitterLastReadAt : feedback.adminLastReadAt;
    // Unread is "rows from the other side", not chat's "rows I did not author".
    // For the submitter the two coincide — only the owner can author a
    // `submitter` row. For staff they differ: admin B does not see admin A's
    // reply as unread. That follows from the single shared `adminLastReadAt`
    // marker the issue prescribes (A marking read advances B's marker too), so
    // per-admin unread is not expressible on this schema by construction, and
    // is a non-event on a single-owner install.
    const otherSide: FeedbackMessageAuthorSide = viewerSide === 'submitter' ? 'admin' : 'submitter';

    const [thread] = await db
      .select({ id: feedback.id, lastReadAt: lastReadAtColumn })
      .from(feedback)
      .where(and(eq(feedback.id, id), submitterScope(submitterUserId)))
      .limit(1);
    if (!thread) return { status: 'not_found' };

    // Page and unread count must share one ordering key. Unread is derived from
    // a `created_at` marker, so the page is keyset-ordered by `created_at` with
    // the UUIDv7 `id` as tiebreak — a row written with an explicit `createdAt`
    // (a backfill, an import, a fixture) then cannot land in a page position
    // that contradicts its own unread classification. The wire cursor stays the
    // message id, so its stamp is resolved here, scoped to this thread.
    const [cursorRow] = params.cursor
      ? await db
          .select({ id: feedbackMessages.id, createdAt: feedbackMessages.createdAt })
          .from(feedbackMessages)
          .where(and(eq(feedbackMessages.feedbackId, id), eq(feedbackMessages.id, params.cursor)))
          .limit(1)
      : [];
    // A cursor naming no row in THIS thread is a client error, not an empty
    // constraint: ignoring it would hand back page one under a `nextCursor` that
    // points at the end of page one again, looping the caller forever instead of
    // telling them the cursor is wrong.
    if (params.cursor && !cursorRow) return { status: 'invalid_cursor' };
    const beforeCursor = cursorRow
      ? or(
          lt(feedbackMessages.createdAt, cursorRow.createdAt),
          and(
            eq(feedbackMessages.createdAt, cursorRow.createdAt),
            lt(feedbackMessages.id, cursorRow.id),
          ),
        )
      : undefined;

    const [unreadRows, rows] = await Promise.all([
      db
        .select({ value: count() })
        .from(feedbackMessages)
        .where(
          and(
            eq(feedbackMessages.feedbackId, id),
            eq(feedbackMessages.authorSide, otherSide),
            thread.lastReadAt ? gt(feedbackMessages.createdAt, thread.lastReadAt) : undefined,
          ),
        ),
      db
        .select()
        .from(feedbackMessages)
        .where(and(eq(feedbackMessages.feedbackId, id), beforeCursor))
        .orderBy(desc(feedbackMessages.createdAt), desc(feedbackMessages.id))
        .limit(params.limit + 1),
    ]);
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    return {
      status: 'ok',
      page: {
        thread: { id: thread.id, unreadCount: unreadRows[0]?.value ?? 0 },
        rows: page,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      },
    };
  }

  /** Insert only after resolving the parent through the appropriate ownership query. */
  async function createMessage(
    authorUserId: string,
    id: string,
    authorSide: FeedbackMessageAuthorSide,
    body: string,
    submitterUserId?: string,
  ): Promise<AdminFeedbackMessageWrite | null> {
    return db.transaction(async (tx) => {
      const [thread] = await tx
        .select({
          id: feedback.id,
          submitterUserId: feedback.userId,
          deletedByUserAt: feedback.deletedByUserAt,
        })
        .from(feedback)
        .where(and(eq(feedback.id, id), submitterScope(submitterUserId)))
        .limit(1);
      if (!thread) return null;

      const [row] = await tx
        .insert(feedbackMessages)
        .values({ feedbackId: id, authorSide, authorUserId, body })
        .returning();
      if (!row) throw new Error('Feedback message vanished after insert');
      return {
        row,
        submitterUserId: thread.submitterUserId,
        deletedByUserAt: thread.deletedByUserAt,
      };
    });
  }

  // ── The admin projection, shared by the list and the single-row read ───────
  // One aliased self-reference drives every thread-derived column, so the
  // correlated subqueries render real schema identifiers rather than hand-typed
  // table and column names that a rename would not catch.
  const msg = alias(feedbackMessages, 'thread_msg');
  // Interpolating an aliased table renders the ALIAS alone, which is what a
  // WHERE clause wants and what a FROM clause cannot use — hence the explicit
  // `table alias` pair here, spelled once.
  const msgFrom = sql`${feedbackMessages} ${msg}`;
  const correlated = eq(msg.feedbackId, feedback.id);
  /**
   * "A submitter message the admin side has not seen." The marker is a single
   * shared `adminLastReadAt`, so this is per-install unread, not per-operator —
   * see the contract note on `unreadCount`.
   */
  const unreadPredicate = and(
    correlated,
    eq(msg.authorSide, 'submitter'),
    or(isNull(feedback.adminLastReadAt), gt(msg.createdAt, feedback.adminLastReadAt)),
  );
  /** `EXISTS` form of the same predicate, for the inbox's unread filter. */
  const anyUnread = sql`exists (select 1 from ${msgFrom} where ${unreadPredicate})`;

  /**
   * The admin row shape. Thread state is four correlated subqueries rather than
   * extra round trips: the page is bounded at 100 rows, and one statement keeps
   * the counters consistent with the page they describe.
   */
  const adminSelection = {
    id: feedback.id,
    userId: feedback.userId,
    category: feedback.category,
    subject: feedback.subject,
    message: feedback.message,
    context: feedback.context,
    status: feedback.status,
    lastStatusChangeAt: feedback.lastStatusChangeAt,
    declinedReason: feedback.declinedReason,
    shippedVersion: feedback.shippedVersion,
    submitterLastReadAt: feedback.submitterLastReadAt,
    adminLastReadAt: feedback.adminLastReadAt,
    deletedByUserAt: feedback.deletedByUserAt,
    archivedAt: feedback.archivedAt,
    createdAt: feedback.createdAt,
    updatedAt: feedback.updatedAt,
    submitterId: users.id,
    submitterUsername: users.username,
    submitterEmail: users.email,
    // `count(*)` is a bigint; postgres-js hands bigints back as strings while
    // PGlite yields numbers. The cast makes both drivers agree on `number`
    // instead of leaking a string into a contract typed as an integer.
    unreadCount: sql<number>`(select count(*)::int from ${msgFrom} where ${unreadPredicate})`,
    messageCount: sql<number>`(select count(*)::int from ${msgFrom} where ${correlated})`,
    lastMessageAt: sql<Date | null>`(
      select ${msg.createdAt} from ${msgFrom} where ${correlated}
      order by ${desc(msg.createdAt)}, ${desc(msg.id)} limit 1
    )`,
    lastAuthorSide: sql<FeedbackMessageAuthorSide | null>`(
      select ${msg.authorSide} from ${msgFrom} where ${correlated}
      order by ${desc(msg.createdAt)}, ${desc(msg.id)} limit 1
    )`,
  };

  /** The selected row is structurally `FeedbackRow` plus the joined/derived columns. */
  type AdminSelectionRow = FeedbackRow & {
    submitterId: string;
    submitterUsername: string;
    submitterEmail: string;
    unreadCount: number;
    messageCount: number;
    lastMessageAt: Date | null;
    lastAuthorSide: FeedbackMessageAuthorSide | null;
  };

  function toAdminRow({
    submitterId,
    submitterUsername,
    submitterEmail,
    lastMessageAt,
    unreadCount,
    messageCount,
    ...rest
  }: AdminSelectionRow): AdminFeedbackRow {
    return {
      ...rest,
      unreadCount: Number(unreadCount),
      messageCount: Number(messageCount),
      // Drivers disagree on timestamp shape for a raw-SQL column: PGlite
      // returns a Date, postgres-js a string. Normalise here so the service's
      // `.toISOString()` cannot throw in production only.
      lastMessageAt: lastMessageAt === null ? null : new Date(lastMessageAt),
      submitter: {
        id: submitterId,
        username: submitterUsername,
        email: submitterEmail,
      },
    };
  }

  return {
    async create(userId, input) {
      return db.transaction(async (tx) => {
        // The stable parent row is the per-user serialization point. A second
        // create cannot count until the first transaction has committed its
        // insert, so two requests at 19 open rows cannot both become row 20.
        const [owner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!owner) throw new Error('Cannot create feedback for a missing user');

        const [open] = await tx
          .select({ value: count() })
          .from(feedback)
          .where(
            and(
              eq(feedback.userId, userId),
              isNull(feedback.deletedByUserAt),
              // The terminal set is the contract's, not a SQL literal list: a
              // status added later is classified in `packages/contracts` (where
              // the partition test forces the choice) instead of silently
              // counting as open here, and a rename fails at compile time.
              notInArray(feedback.status, [...FEEDBACK_TERMINAL_STATUSES]),
            ),
          );
        if ((open?.value ?? 0) >= FEEDBACK_OPEN_SUBMISSION_LIMIT) return null;

        const values: NewFeedbackRow = {
          userId,
          category: input.category,
          subject: input.subject ?? null,
          message: input.message,
          context: (input.context ?? null) as NewFeedbackRow['context'],
        };
        const [row] = await tx.insert(feedback).values(values).returning();
        if (!row) throw new Error('Feedback vanished after insert');
        return row;
      });
    },

    async listMine(userId) {
      const rows = await db
        .select()
        .from(feedback)
        .where(and(eq(feedback.userId, userId), isNull(feedback.deletedByUserAt)))
        .orderBy(desc(feedback.createdAt), desc(feedback.id));
      if (rows.length === 0) return [];

      const unreadRows = await db
        .select({ feedbackId: feedbackMessages.feedbackId, value: count() })
        .from(feedbackMessages)
        .innerJoin(feedback, eq(feedback.id, feedbackMessages.feedbackId))
        .where(
          and(
            eq(feedback.userId, userId),
            isNull(feedback.deletedByUserAt),
            eq(feedbackMessages.authorSide, 'admin'),
            or(
              isNull(feedback.submitterLastReadAt),
              gt(feedbackMessages.createdAt, feedback.submitterLastReadAt),
            ),
          ),
        )
        .groupBy(feedbackMessages.feedbackId);
      const unreadByFeedback = new Map(
        unreadRows.map((row) => [row.feedbackId, row.value] as const),
      );
      return rows.map((row) => ({
        ...row,
        unreadReplyCount: unreadByFeedback.get(row.id) ?? 0,
      }));
    },

    async getThreadForSubmitter(userId, id, params) {
      return getThread(id, 'submitter', params, userId);
    },

    async getThreadForAdmin(id, params) {
      return getThread(id, 'admin', params);
    },

    async createMessageForSubmitter(userId, id, body) {
      return (await createMessage(userId, id, 'submitter', body, userId))?.row ?? null;
    },

    async createMessageForAdmin(adminUserId, id, body) {
      return createMessage(adminUserId, id, 'admin', body);
    },

    async markReadForSubmitter(userId, id) {
      const rows = await db
        .update(feedback)
        .set({ submitterLastReadAt: sql`now()` })
        .where(and(eq(feedback.id, id), submitterScope(userId)))
        .returning({ id: feedback.id });
      return rows.length > 0;
    },

    async markReadForAdmin(id) {
      const rows = await db
        .update(feedback)
        .set({ adminLastReadAt: sql`now()` })
        .where(eq(feedback.id, id))
        .returning({ id: feedback.id });
      return rows.length > 0;
    },

    async deleteMine(userId, id, at) {
      // Both tombstone stamps ride raw SQL fragments (COALESCE + CASE keep the
      // repeat idempotent), which puts them OUTSIDE the column's drizzle type
      // mapping: the `Date` reaches postgres-js unencoded and its Bind writer
      // throws `ERR_INVALID_ARG_TYPE` on a non-string, so every DELETE answered
      // 500 in production while PGlite — which serialises a `Date` happily —
      // kept the whole suite green. Explicit ISO string + ::timestamptz cast,
      // exactly as #437's notification-archive COALESCE already does.
      const atIso = at.toISOString();
      const [row] = await db
        .update(feedback)
        .set({
          deletedByUserAt: sql<Date>`coalesce(${feedback.deletedByUserAt}, ${atIso}::timestamptz)`,
          updatedAt: sql<Date>`case
            when ${feedback.deletedByUserAt} is null then ${atIso}::timestamptz
            else ${feedback.updatedAt}
          end`,
        })
        .where(and(eq(feedback.id, id), eq(feedback.userId, userId)))
        .returning();
      return row ?? null;
    },

    async getForAdmin(id) {
      // Id-addressed, deliberately unfiltered: a helpdesk link must open its
      // thread whatever the operator's saved filters say, including an archived
      // or user-tombstoned row the inbox is currently hiding.
      const [row] = await db
        .select(adminSelection)
        .from(feedback)
        .innerJoin(users, eq(feedback.userId, users.id))
        .where(eq(feedback.id, id))
        .limit(1);
      return row ? toAdminRow(row as AdminSelectionRow) : null;
    },

    async listForAdmin(params) {
      const conditions: SQL[] = [];
      if (params.category) conditions.push(eq(feedback.category, params.category));
      if (params.status) conditions.push(eq(feedback.status, params.status));
      if (params.version) conditions.push(eq(feedback.shippedVersion, params.version));
      if (params.q) {
        const pattern = `%${escapeLikePattern(params.q)}%`;
        // Submitter identity is searchable because "the ticket from martin.k"
        // is how an operator remembers a thread. Both columns are already on
        // this join and already rendered in the row.
        const match = or(
          ilike(feedback.subject, pattern),
          ilike(feedback.message, pattern),
          ilike(users.username, pattern),
          ilike(users.email, pattern),
        );
        if (match) conditions.push(match);
      }
      if (params.unread !== undefined) {
        conditions.push(params.unread ? anyUnread : sql`not ${anyUnread}`);
      }
      conditions.push(
        params.archived ? isNotNull(feedback.archivedAt) : isNull(feedback.archivedAt),
      );
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const priorityOrder = sql<number>`case ${feedback.category}
        when 'feature' then 0
        when 'bug' then 1
        when 'other' then 2
        when 'help' then 3
        when 'improvement' then 4
        else 5
      end`;

      /**
       * Every ordering ends on the `id` tiebreak. Without it two rows sharing
       * the leading key can swap between page 1 and page 2 under a stable
       * filter, and one of them is then never shown to the operator at all.
       */
      const orderBy =
        params.sort === 'category'
          ? [priorityOrder, desc(feedback.createdAt), desc(feedback.id)]
          : params.sort === 'aging'
            ? // Longest-untouched first: the aging clock is the last lifecycle
              // move, not the filing date.
              [asc(feedback.lastStatusChangeAt), asc(feedback.id)]
            : [desc(feedback.createdAt), desc(feedback.id)];

      const rows = await db
        .select(adminSelection)
        .from(feedback)
        .innerJoin(users, eq(feedback.userId, users.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(params.limit)
        .offset((params.page - 1) * params.limit);

      // The total must be scoped by the SAME predicate as the page. `q` and the
      // unread filter reach through the users join, so the count carries it too
      // — counting the bare table would report a total the filter never returns
      // and page the operator into empty results.
      const [totalRow] = await db
        .select({ value: count() })
        .from(feedback)
        .innerJoin(users, eq(feedback.userId, users.id))
        .where(where);
      return {
        rows: rows.map((row) => toAdminRow(row as AdminSelectionRow)),
        total: totalRow?.value ?? 0,
      };
    },

    async setStatus(id, input) {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(feedback).where(eq(feedback.id, id)).for('update');
        if (!current) return null;

        const declinedReason = input.status === 'declined' ? (input.declinedReason ?? null) : null;
        const shippedVersion = input.status === 'shipped' ? (input.shippedVersion ?? null) : null;
        if (
          current.status === input.status &&
          current.declinedReason === declinedReason &&
          current.shippedVersion === shippedVersion
        ) {
          // HTTP retries are not new transitions: preserve the natural
          // (submission id + lastStatusChangeAt) notification identity.
          return { row: current, changed: false };
        }

        // This timestamp is both lifecycle state and the durable notification
        // identity, so allocate it only after the row lock serializes competing
        // transitions. A coarse or backwards-moving wall clock must not make two
        // genuine transitions share an event key.
        const observedAt = now();
        const transitionAt = new Date(
          Math.max(observedAt.getTime(), current.lastStatusChangeAt.getTime() + 1),
        );
        const [row] = await tx
          .update(feedback)
          .set({
            status: input.status,
            lastStatusChangeAt: transitionAt,
            declinedReason,
            shippedVersion,
            updatedAt: transitionAt,
          })
          .where(eq(feedback.id, id))
          .returning();
        if (!row) throw new Error('Feedback vanished during its locked status transition');
        return { row, changed: true };
      });
    },

    async setArchived(id, archived, at) {
      return db.transaction(async (tx) => {
        // The row lock makes a repeated archive/unarchive a genuine no-op: it
        // preserves both timestamps and the audit trail instead of merely
        // converging the final state after two writes race each other.
        const [current] = await tx.select().from(feedback).where(eq(feedback.id, id)).for('update');
        if (!current) return null;

        if ((current.archivedAt !== null) === archived) {
          return { row: current, changed: false };
        }

        const [row] = await tx
          .update(feedback)
          // Archiving is workspace hygiene, yet it bumps `updatedAt` — a column
          // that otherwise tracks lifecycle edits. Harmless today (both sorts
          // key on `createdAt`, and the submitter rail never carries the
          // column), but a surface that renders "last updated" (#1341) would
          // show a filing action as an edit and must decide deliberately.
          .set({ archivedAt: archived ? at : null, updatedAt: at })
          .where(eq(feedback.id, id))
          .returning();
        if (!row) throw new Error('Feedback vanished during archive mutation');
        return { row, changed: true };
      });
    },
  };
}
