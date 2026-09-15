import { count, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { adminModerationActions, adminUserFlags, users } from '../schema';

/**
 * The moderation record and the review flag (#1907 ADMIN-W5).
 *
 * Every read here is scoped by `user_id` IN THE REPOSITORY, never by a caller
 * remembering to pass a filter (§10): the moderation record of account A must
 * be unreachable from a request for account B even if a route hands the wrong
 * id down. The projection is deliberately narrow for the same reason the People
 * 360 reads are — the actor resolves to a USERNAME and nothing else, and
 * `previousValue` / `nextValue` carry short state labels that can never hold
 * anything that came out of a portfolio (§6.12).
 *
 * The write side is split in two on purpose. {@link createAdminModerationQueries}
 * is bound to whatever database handle it is given, so a caller that already
 * owns a transaction (the admin service's serialized user mutation) records the
 * action INSIDE that transaction and a suspension can never commit without its
 * reason. {@link AdminModerationRepository.inTransaction} is the seam for the
 * writes that own no outer transaction — flag and unflag.
 */

export type AdminModerationActionKind =
  | 'disable'
  | 'enable'
  | 'chat_ban'
  | 'chat_unban'
  | 'role_change'
  | 'flag'
  | 'unflag'
  | 'password_reset';

export interface RecordModerationActionInput {
  userId: string;
  /** The operator. Null only for a row whose admin account was later deleted. */
  actorId: string | null;
  action: AdminModerationActionKind;
  reason: string;
  /** Short state labels only — never portfolio-derived content. */
  previousValue?: string | null;
  nextValue?: string | null;
}

export interface AdminModerationActionRow {
  id: string;
  action: string;
  reason: string;
  previousValue: string | null;
  nextValue: string | null;
  actorId: string | null;
  actorUsername: string | null;
  createdAt: Date;
}

export interface AdminUserFlagRow {
  userId: string;
  reason: string;
  flaggedBy: string | null;
  flaggedAt: Date;
}

export function createAdminModerationQueries(db: Database) {
  return {
    /**
     * Append one action. The id comes back so the audit row can point AT the
     * moderation row instead of copying its reason: the reason is a bounded
     * column in one place, and duplicating free prose into the audit log's
     * unbounded `meta` would create a second, longer-lived store of it.
     */
    async record(input: RecordModerationActionInput): Promise<{ id: string }> {
      const [row] = await db
        .insert(adminModerationActions)
        .values({
          userId: input.userId,
          actorId: input.actorId,
          action: input.action,
          reason: input.reason.trim(),
          previousValue: input.previousValue ?? null,
          nextValue: input.nextValue ?? null,
        })
        .returning({ id: adminModerationActions.id });
      if (!row) throw new Error('Failed to insert a moderation action.');
      return row;
    },

    /**
     * One account's record, newest first with a stable `id` tiebreak — two
     * actions of a single PATCH share a `created_at` by construction, so
     * without it a page boundary could drop or repeat a row.
     */
    async listFor(
      userId: string,
      limit: number,
      offset: number,
    ): Promise<{ rows: AdminModerationActionRow[]; total: number }> {
      const rows = await db
        .select({
          id: adminModerationActions.id,
          action: adminModerationActions.action,
          reason: adminModerationActions.reason,
          previousValue: adminModerationActions.previousValue,
          nextValue: adminModerationActions.nextValue,
          actorId: adminModerationActions.actorId,
          actorUsername: users.username,
          createdAt: adminModerationActions.createdAt,
        })
        .from(adminModerationActions)
        .leftJoin(users, eq(adminModerationActions.actorId, users.id))
        .where(eq(adminModerationActions.userId, userId))
        .orderBy(desc(adminModerationActions.createdAt), desc(adminModerationActions.id))
        .limit(limit)
        .offset(offset);

      const [totalRow] = await db
        .select({ value: count() })
        .from(adminModerationActions)
        .where(eq(adminModerationActions.userId, userId));

      return { rows, total: totalRow?.value ?? 0 };
    },

    /** The current flag, or undefined when the account is not flagged. */
    async flagFor(userId: string): Promise<AdminUserFlagRow | undefined> {
      const [row] = await db
        .select()
        .from(adminUserFlags)
        .where(eq(adminUserFlags.userId, userId))
        .limit(1);
      return row;
    },

    /**
     * Which of these accounts are flagged. One round trip for a whole page of
     * the users list, the same shape the paranoid metadata read uses — a
     * per-row lookup would be one query per rendered account.
     */
    async flaggedAmong(userIds: string[]): Promise<Set<string>> {
      if (userIds.length === 0) return new Set();
      const rows = await db
        .select({ userId: adminUserFlags.userId })
        .from(adminUserFlags)
        .where(inArray(adminUserFlags.userId, userIds));
      return new Set(rows.map((row) => row.userId));
    },

    /**
     * Raise or update the flag. Idempotent by construction: a second flag is an
     * upsert onto the same primary key that replaces the reason and re-stamps
     * the operator, never a second row and never a unique-violation 500.
     */
    async upsertFlag(input: {
      userId: string;
      reason: string;
      flaggedBy: string | null;
    }): Promise<void> {
      await db
        .insert(adminUserFlags)
        .values({
          userId: input.userId,
          reason: input.reason.trim(),
          flaggedBy: input.flaggedBy,
        })
        .onConflictDoUpdate({
          target: adminUserFlags.userId,
          set: {
            reason: input.reason.trim(),
            flaggedBy: input.flaggedBy,
            flaggedAt: sql`now()`,
          },
        });
    },

    /**
     * Drop the flag. Returns whether there was one: clearing an unflagged
     * account is a no-op that must NOT append an "unflag" nobody performed.
     */
    async deleteFlag(userId: string): Promise<boolean> {
      const removed = await db
        .delete(adminUserFlags)
        .where(eq(adminUserFlags.userId, userId))
        .returning({ userId: adminUserFlags.userId });
      return removed.length > 0;
    },
  };
}

export type AdminModerationQueries = ReturnType<typeof createAdminModerationQueries>;

export function createAdminModerationRepository(db: Database) {
  return {
    ...createAdminModerationQueries(db),

    /**
     * Bind the moderation writes to a transaction somebody else owns, so the
     * state change and its reason commit or roll back together.
     */
    forTransaction: (tx: Database): AdminModerationQueries => createAdminModerationQueries(tx),

    /**
     * One transaction for a write that owns no outer one (flag / unflag): the
     * flag row and the action row are the same fact recorded twice, and a flag
     * without its action is exactly the unattributed state this wave removes.
     */
    async inTransaction<T>(run: (queries: AdminModerationQueries) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) =>
        run(createAdminModerationQueries(tx as unknown as Database)),
      );
    },
  };
}

export type AdminModerationRepository = ReturnType<typeof createAdminModerationRepository>;
