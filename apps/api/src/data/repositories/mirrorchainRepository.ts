import { and, asc, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  MirrorMemberRole,
  MirrorMemberStatus,
  MirrorOpKind,
  MirrorOpPayload,
  MirrorRowKind,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  mirrorChainInvites,
  mirrorChainMembers,
  mirrorChainOps,
  mirrorChains,
  mirrorRows,
  users,
} from '../schema';
import type {
  MirrorChainInviteRow,
  MirrorChainMemberRow,
  MirrorChainOpRow,
  MirrorChainRow,
  MirrorRowRow,
} from '../schema';

/**
 * MIRRORCHAIN persistence (§13.5 V5-P7; `docs/mirrorchain-design.md` §§1–2). All
 * SQL for the five chain link tables lives here; the `mirrorService` (M2) holds
 * the rules. This is M1 — the storage access patterns §2 needs, no replication
 * behavior:
 *  - **append with the `last_seq` lock** ({@link appendOps}): the linearization
 *    point — `UPDATE mirror_chains SET last_seq = last_seq + n RETURNING` takes
 *    the chain row lock, serializing all concurrent writers of one chain and
 *    assigning each op a dense `seq`;
 *  - **seq-ordered reads** ({@link listOpsSince} / {@link latestOpForEntity}) for
 *    per-copy replay and the §3 conflict/version lookup;
 *  - **watermarks** ({@link advanceWatermark}) — monotonic per-copy `applied_seq`;
 *  - **membership lookups** ({@link findActiveMembershipByPortfolio} etc.) —
 *    identifying a synced copy and enumerating a chain's active members.
 */

export interface CreateChainInput {
  name: string;
  createdBy: string;
  createdByUsername: string;
}

export interface InsertMemberInput {
  chainId: string;
  userId: string;
  username: string;
  portfolioId: string;
  role: MirrorMemberRole;
  invitedBy?: string | null;
}

export interface CreateInviteInput {
  chainId: string;
  fromUser: string;
  toUser: string;
}

/** One op to append; `seq` is assigned by {@link appendOps} under the chain lock. */
export interface AppendOpInput {
  kind: MirrorOpKind;
  mirrorId?: string | null;
  actorUserId: string | null;
  actorUsername: string;
  originPortfolioId?: string | null;
  payload: MirrorOpPayload;
  /**
   * Optimistic-concurrency base for {@link appendOpsChecked} (design §3): the
   * entity's latest op seq the writer edited against (0 = no prior op).
   * `undefined` skips the guard (creates mint fresh ids, so nothing to race).
   */
  baseSeq?: number;
}

/**
 * Why a guarded append was refused (design §§2–3). The whole append transaction
 * rolls back — `last_seq` is not consumed and no op row exists.
 */
export type AppendRefusal =
  | { refused: 'NOT_A_MEMBER' }
  | { refused: 'CONFLICT'; mirrorId: string; expectedSeq: number; actualSeq: number }
  | { refused: 'ROW_DELETED'; mirrorId: string };

export type CheckedAppendResult = { ops: MirrorChainOpRow[] } | AppendRefusal;

/** Ops whose presence as an entity's latest op make it terminally deleted (§3). */
const TERMINAL_OP_KINDS: readonly MirrorOpKind[] = ['tx.delete', 'dividend.delete'];

/** Internal control-flow error: rolls the append transaction back on refusal. */
class AppendRefusedError extends Error {
  constructor(public readonly refusal: AppendRefusal) {
    super(`mirror append refused: ${refusal.refused}`);
  }
}

export interface InsertMirrorRowInput {
  chainId: string;
  kind: MirrorRowKind;
  mirrorId: string;
  portfolioId: string;
  localId: string;
  /** Nullable: attribution survives the creator's account deletion (§1). */
  createdBy: string | null;
  createdByUsername: string;
}

/** A member row plus the live profile icon for the member sheet (M3, design §10/§11). */
export interface MirrorMemberDetailRow extends MirrorChainMemberRow {
  /** From the joined `users` row; null when the account was deleted (SET NULL). */
  profileIcon: string | null;
}

/** A pending invite enriched with the chain name + both usernames (M3, design §4). */
export interface MirrorInviteDetailRow extends MirrorChainInviteRow {
  chainName: string;
  fromUsername: string | null;
  toUsername: string;
}

export function createMirrorchainRepository(db: Database) {
  return {
    // --- Chains -------------------------------------------------------------

    /** Create a chain, `status='active'`, `last_seq=0`. */
    async createChain(input: CreateChainInput): Promise<MirrorChainRow> {
      const [row] = await db
        .insert(mirrorChains)
        .values({
          name: input.name,
          createdBy: input.createdBy,
          createdByUsername: input.createdByUsername,
        })
        .returning();
      return row!;
    },

    async getChain(chainId: string): Promise<MirrorChainRow | null> {
      const [row] = await db.select().from(mirrorChains).where(eq(mirrorChains.id, chainId));
      return row ?? null;
    },

    /** Rename the chain (name is authoritative on the chain row, design §1). */
    async renameChain(chainId: string, name: string): Promise<void> {
      await db.update(mirrorChains).set({ name }).where(eq(mirrorChains.id, chainId));
    },

    /** Flip a chain to `dissolved` (chains are never hard-deleted, design §1). */
    async markChainDissolved(chainId: string, dissolvedAt: Date): Promise<void> {
      await db
        .update(mirrorChains)
        .set({ status: 'dissolved', dissolvedAt })
        .where(eq(mirrorChains.id, chainId));
    },

    // --- Op append + reads --------------------------------------------------

    /**
     * Append one or more ops in a single transaction, assigning dense consecutive
     * `seq`s under the `mirror_chains` row lock (design §2). The
     * `UPDATE … SET last_seq = last_seq + n RETURNING last_seq` both reserves the
     * range and serializes concurrent writers of the same chain, so seqs are
     * gap-free and every op's ordering is total. A batch (multi-row) submit lands
     * as one call so its ops carry consecutive seqs. Returns the inserted op rows
     * in seq order.
     */
    async appendOps(chainId: string, ops: AppendOpInput[]): Promise<MirrorChainOpRow[]> {
      if (ops.length === 0) return [];
      return db.transaction(async (tx) => {
        const [chain] = await tx
          .update(mirrorChains)
          .set({ lastSeq: sql`${mirrorChains.lastSeq} + ${ops.length}` })
          .where(eq(mirrorChains.id, chainId))
          .returning({ lastSeq: mirrorChains.lastSeq });
        if (!chain) throw new Error(`mirror chain ${chainId} not found`);
        const startSeq = chain.lastSeq - ops.length + 1;
        const values = ops.map((op, i) => ({
          chainId,
          seq: startSeq + i,
          kind: op.kind,
          mirrorId: op.mirrorId ?? null,
          actorUserId: op.actorUserId,
          actorUsername: op.actorUsername,
          originPortfolioId: op.originPortfolioId ?? null,
          payload: op.payload,
        }));
        return tx.insert(mirrorChainOps).values(values).returning();
      });
    },

    /**
     * Guarded append (M2, design §§2–3): {@link appendOps} plus, in the SAME
     * transaction that holds the `mirror_chains` row lock and assigns seqs,
     *  - the actor's **active membership** check — an op submitted after a
     *    kick/leave op took an earlier seq is refused (`NOT_A_MEMBER`), so a
     *    severed member can never race a write past their removal;
     *  - the §3 **stale-edit guard** — an op carrying `baseSeq` is refused
     *    (`CONFLICT`) when the entity's current latest-op seq differs; and
     *  - the **terminal-delete guard** — any op targeting an entity whose
     *    latest op is a `*.delete` is refused (`ROW_DELETED`).
     * The version check and the seq assignment share this transaction, so two
     * concurrent guarded appends against the same base can never both pass
     * (design §3 Case B). On refusal the transaction rolls back whole.
     */
    async appendOpsChecked(
      chainId: string,
      actorUserId: string,
      ops: AppendOpInput[],
    ): Promise<CheckedAppendResult> {
      if (ops.length === 0) return { ops: [] };
      try {
        const rows = await db.transaction(async (tx) => {
          const [chain] = await tx
            .update(mirrorChains)
            .set({ lastSeq: sql`${mirrorChains.lastSeq} + ${ops.length}` })
            .where(eq(mirrorChains.id, chainId))
            .returning({ lastSeq: mirrorChains.lastSeq });
          if (!chain) throw new Error(`mirror chain ${chainId} not found`);

          const [member] = await tx
            .select()
            .from(mirrorChainMembers)
            .where(
              and(
                eq(mirrorChainMembers.chainId, chainId),
                eq(mirrorChainMembers.userId, actorUserId),
                eq(mirrorChainMembers.status, 'active'),
              ),
            );
          if (!member) throw new AppendRefusedError({ refused: 'NOT_A_MEMBER' });

          for (const op of ops) {
            if (op.baseSeq === undefined || !op.mirrorId) continue;
            const [latest] = await tx
              .select()
              .from(mirrorChainOps)
              .where(
                and(eq(mirrorChainOps.chainId, chainId), eq(mirrorChainOps.mirrorId, op.mirrorId)),
              )
              .orderBy(desc(mirrorChainOps.seq))
              .limit(1);
            if (latest && TERMINAL_OP_KINDS.includes(latest.kind as MirrorOpKind)) {
              throw new AppendRefusedError({ refused: 'ROW_DELETED', mirrorId: op.mirrorId });
            }
            const actualSeq = latest?.seq ?? 0;
            if (actualSeq !== op.baseSeq) {
              throw new AppendRefusedError({
                refused: 'CONFLICT',
                mirrorId: op.mirrorId,
                expectedSeq: op.baseSeq,
                actualSeq,
              });
            }
          }

          const startSeq = chain.lastSeq - ops.length + 1;
          const values = ops.map((op, i) => ({
            chainId,
            seq: startSeq + i,
            kind: op.kind,
            mirrorId: op.mirrorId ?? null,
            actorUserId: op.actorUserId,
            actorUsername: op.actorUsername,
            originPortfolioId: op.originPortfolioId ?? null,
            payload: op.payload,
          }));
          return tx.insert(mirrorChainOps).values(values).returning();
        });
        return { ops: rows };
      } catch (err) {
        if (err instanceof AppendRefusedError) return err.refusal;
        throw err;
      }
    },

    /** Ops with `seq > afterSeq`, ascending — the per-copy replay window. */
    async listOpsSince(chainId: string, afterSeq: number): Promise<MirrorChainOpRow[]> {
      return db
        .select()
        .from(mirrorChainOps)
        .where(and(eq(mirrorChainOps.chainId, chainId), gt(mirrorChainOps.seq, afterSeq)))
        .orderBy(asc(mirrorChainOps.seq));
    },

    /**
     * The highest-seq op targeting `mirrorId` — the §3 conflict guard's
     * "entity's latest op" and the source of a row's `mirror.version`. Null when
     * the entity has no ops yet.
     */
    async latestOpForEntity(chainId: string, mirrorId: string): Promise<MirrorChainOpRow | null> {
      const [row] = await db
        .select()
        .from(mirrorChainOps)
        .where(and(eq(mirrorChainOps.chainId, chainId), eq(mirrorChainOps.mirrorId, mirrorId)))
        .orderBy(desc(mirrorChainOps.seq))
        .limit(1);
      return row ?? null;
    },

    /**
     * The lowest-seq op targeting `mirrorId` — the entity's create op, the only
     * carrier of its immutable identity (a transaction's asset) once the local
     * row is gone (the correction path's crash heal, design §2).
     */
    async firstOpForEntity(chainId: string, mirrorId: string): Promise<MirrorChainOpRow | null> {
      const [row] = await db
        .select()
        .from(mirrorChainOps)
        .where(and(eq(mirrorChainOps.chainId, chainId), eq(mirrorChainOps.mirrorId, mirrorId)))
        .orderBy(asc(mirrorChainOps.seq))
        .limit(1);
      return row ?? null;
    },

    /**
     * One page of the activity feed (design §6/§11): ops with `seq < before`
     * (or the tail when `before` is omitted), newest-first, capped at `limit`.
     * The oplog is the chain-level audit trail, so this reads it directly.
     */
    async listActivity(
      chainId: string,
      opts: { before?: number; limit: number },
    ): Promise<MirrorChainOpRow[]> {
      const where =
        opts.before !== undefined
          ? and(eq(mirrorChainOps.chainId, chainId), lt(mirrorChainOps.seq, opts.before))
          : eq(mirrorChainOps.chainId, chainId);
      return db
        .select()
        .from(mirrorChainOps)
        .where(where)
        .orderBy(desc(mirrorChainOps.seq))
        .limit(opts.limit);
    },

    // --- Members + watermarks ----------------------------------------------

    async insertMember(input: InsertMemberInput): Promise<MirrorChainMemberRow> {
      const [row] = await db
        .insert(mirrorChainMembers)
        .values({
          chainId: input.chainId,
          userId: input.userId,
          username: input.username,
          portfolioId: input.portfolioId,
          role: input.role,
          invitedBy: input.invitedBy ?? null,
        })
        .returning();
      return row!;
    },

    /** Active membership for a portfolio — the "is this a synced copy?" lookup (§1). */
    async findActiveMembershipByPortfolio(
      portfolioId: string,
    ): Promise<MirrorChainMemberRow | null> {
      const [row] = await db
        .select()
        .from(mirrorChainMembers)
        .where(
          and(
            eq(mirrorChainMembers.portfolioId, portfolioId),
            eq(mirrorChainMembers.status, 'active'),
          ),
        );
      return row ?? null;
    },

    /** A user's active membership in a given chain (role/authority checks, §5). */
    async findActiveMembership(
      chainId: string,
      userId: string,
    ): Promise<MirrorChainMemberRow | null> {
      const [row] = await db
        .select()
        .from(mirrorChainMembers)
        .where(
          and(
            eq(mirrorChainMembers.chainId, chainId),
            eq(mirrorChainMembers.userId, userId),
            eq(mirrorChainMembers.status, 'active'),
          ),
        );
      return row ?? null;
    },

    /** All active members of a chain, earliest join first (fan-out + succession). */
    async listActiveMembers(chainId: string): Promise<MirrorChainMemberRow[]> {
      return db
        .select()
        .from(mirrorChainMembers)
        .where(
          and(eq(mirrorChainMembers.chainId, chainId), eq(mirrorChainMembers.status, 'active')),
        )
        .orderBy(asc(mirrorChainMembers.joinedAt), asc(mirrorChainMembers.userId));
    },

    /** A user's active memberships across all chains (switcher / deletion sweep). */
    async listActiveMembershipsForUser(userId: string): Promise<MirrorChainMemberRow[]> {
      return db
        .select()
        .from(mirrorChainMembers)
        .where(and(eq(mirrorChainMembers.userId, userId), eq(mirrorChainMembers.status, 'active')));
    },

    /** Count active members of a chain (the §4 member-cap check + summary count). */
    async countActiveMembers(chainId: string): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(mirrorChainMembers)
        .where(
          and(eq(mirrorChainMembers.chainId, chainId), eq(mirrorChainMembers.status, 'active')),
        );
      return row?.n ?? 0;
    },

    /**
     * Active members with their live profile icon (the member sheet, design
     * §10/§11), earliest join first. Left join so an account-deleted member
     * (`user_id` SET NULL) still renders from the denormalized username.
     */
    async listMembersDetailed(chainId: string): Promise<MirrorMemberDetailRow[]> {
      const rows = await db
        .select({ member: mirrorChainMembers, profileIcon: users.profileIcon })
        .from(mirrorChainMembers)
        .leftJoin(users, eq(users.id, mirrorChainMembers.userId))
        .where(
          and(eq(mirrorChainMembers.chainId, chainId), eq(mirrorChainMembers.status, 'active')),
        )
        .orderBy(asc(mirrorChainMembers.joinedAt), asc(mirrorChainMembers.userId));
      return rows.map((r) => ({ ...r.member, profileIcon: r.profileIcon ?? null }));
    },

    /** Update a member's role (grant/revoke/transfer, design §5). */
    async updateMemberRole(memberId: string, role: MirrorMemberRole): Promise<void> {
      await db.update(mirrorChainMembers).set({ role }).where(eq(mirrorChainMembers.id, memberId));
    },

    /** End a membership (kick/leave/dissolve/account-deletion → tombstone, §6/§7). */
    async endMembership(
      memberId: string,
      status: MirrorMemberStatus,
      endedAt: Date,
    ): Promise<void> {
      await db
        .update(mirrorChainMembers)
        .set({ status, endedAt })
        .where(eq(mirrorChainMembers.id, memberId));
    },

    /**
     * Advance a copy's watermark to `seq`, monotonically — the guarded
     * `applied_seq < seq` clause makes a re-delivered apply a harmless no-op
     * (design §2 at-least-once/exactly-once). Returns whether the row moved.
     */
    async advanceWatermark(memberId: string, seq: number): Promise<boolean> {
      const updated = await db
        .update(mirrorChainMembers)
        .set({ appliedSeq: seq })
        .where(and(eq(mirrorChainMembers.id, memberId), lt(mirrorChainMembers.appliedSeq, seq)))
        .returning({ id: mirrorChainMembers.id });
      return updated.length > 0;
    },

    // --- Invites ------------------------------------------------------------

    async createInvite(input: CreateInviteInput): Promise<MirrorChainInviteRow> {
      const [row] = await db
        .insert(mirrorChainInvites)
        .values({ chainId: input.chainId, fromUser: input.fromUser, toUser: input.toUser })
        .returning();
      return row!;
    },

    /** The pending invite for (chain, invitee), if any (uniqueness anchor, §4). */
    async findPendingInvite(chainId: string, toUser: string): Promise<MirrorChainInviteRow | null> {
      const [row] = await db
        .select()
        .from(mirrorChainInvites)
        .where(
          and(
            eq(mirrorChainInvites.chainId, chainId),
            eq(mirrorChainInvites.toUser, toUser),
            eq(mirrorChainInvites.status, 'pending'),
          ),
        );
      return row ?? null;
    },

    /** A user's pending invites (Social request list, §4). */
    async listPendingInvitesForUser(toUser: string): Promise<MirrorChainInviteRow[]> {
      return db
        .select()
        .from(mirrorChainInvites)
        .where(and(eq(mirrorChainInvites.toUser, toUser), eq(mirrorChainInvites.status, 'pending')))
        .orderBy(desc(mirrorChainInvites.createdAt));
    },

    async setInviteStatus(
      inviteId: string,
      status: MirrorChainInviteRow['status'],
      respondedAt: Date,
    ): Promise<void> {
      await db
        .update(mirrorChainInvites)
        .set({ status, respondedAt })
        .where(eq(mirrorChainInvites.id, inviteId));
    },

    /**
     * Retire every pending invite created before `cutoff` — the daily
     * `mirror.inviteCleanup` sweep enforcing the §4 30-day token hygiene. Frees
     * the `(chain, invitee)` pending-unique slot and stamps `responded_at` with
     * the sweep time, matching how the accept path marks a single stale invite
     * expired. Returns the number of rows retired.
     */
    async expireStalePendingInvites(cutoff: Date): Promise<number> {
      const rows = await db
        .update(mirrorChainInvites)
        .set({ status: 'expired', respondedAt: new Date() })
        .where(
          and(eq(mirrorChainInvites.status, 'pending'), lt(mirrorChainInvites.createdAt, cutoff)),
        )
        .returning({ id: mirrorChainInvites.id });
      return rows.length;
    },

    /** Fetch one invite by id (accept/decline/revoke authorization, §4). */
    async getInvite(inviteId: string): Promise<MirrorChainInviteRow | null> {
      const [row] = await db
        .select()
        .from(mirrorChainInvites)
        .where(eq(mirrorChainInvites.id, inviteId));
      return row ?? null;
    },

    /**
     * A user's pending invites in BOTH directions (design §4 + the Social
     * request list), enriched with the chain name and both usernames via joins —
     * incoming (`to_user = userId`) and outgoing (`from_user = userId`), newest
     * first. `from_user` may be null (inviter's account deleted).
     */
    async listInvitesForUserDetailed(userId: string): Promise<MirrorInviteDetailRow[]> {
      const fromU = alias(users, 'from_u');
      const toU = alias(users, 'to_u');
      const rows = await db
        .select({
          invite: mirrorChainInvites,
          chainName: mirrorChains.name,
          fromUsername: fromU.username,
          toUsername: toU.username,
        })
        .from(mirrorChainInvites)
        .innerJoin(mirrorChains, eq(mirrorChains.id, mirrorChainInvites.chainId))
        .leftJoin(fromU, eq(fromU.id, mirrorChainInvites.fromUser))
        .innerJoin(toU, eq(toU.id, mirrorChainInvites.toUser))
        .where(
          and(
            eq(mirrorChainInvites.status, 'pending'),
            or(eq(mirrorChainInvites.toUser, userId), eq(mirrorChainInvites.fromUser, userId)),
          ),
        )
        .orderBy(desc(mirrorChainInvites.createdAt));
      return rows.map((r) => ({
        ...r.invite,
        chainName: r.chainName,
        fromUsername: r.fromUsername ?? null,
        toUsername: r.toUsername,
      }));
    },

    // --- Mirror rows (logical↔local identity map) --------------------------

    async insertMirrorRow(input: InsertMirrorRowInput): Promise<MirrorRowRow> {
      const [row] = await db
        .insert(mirrorRows)
        .values({
          chainId: input.chainId,
          kind: input.kind,
          mirrorId: input.mirrorId,
          portfolioId: input.portfolioId,
          localId: input.localId,
          createdBy: input.createdBy,
          createdByUsername: input.createdByUsername,
        })
        .returning();
      return row!;
    },

    /** Insert several links in ONE statement — atomic (a transfer's paired legs). */
    async insertMirrorRows(inputs: InsertMirrorRowInput[]): Promise<MirrorRowRow[]> {
      if (inputs.length === 0) return [];
      return db
        .insert(mirrorRows)
        .values(
          inputs.map((input) => ({
            chainId: input.chainId,
            kind: input.kind,
            mirrorId: input.mirrorId,
            portfolioId: input.portfolioId,
            localId: input.localId,
            createdBy: input.createdBy,
            createdByUsername: input.createdByUsername,
          })),
        )
        .returning();
    },

    /**
     * Resolve one copy's local row for a logical entity (the PK lookup) — used to
     * find the local target of a replicated write and as the create idempotency
     * check (design §2: skip if the row already exists).
     */
    async findMirrorRow(
      kind: MirrorRowKind,
      mirrorId: string,
      portfolioId: string,
    ): Promise<MirrorRowRow | null> {
      const [row] = await db
        .select()
        .from(mirrorRows)
        .where(
          and(
            eq(mirrorRows.kind, kind),
            eq(mirrorRows.mirrorId, mirrorId),
            eq(mirrorRows.portfolioId, portfolioId),
          ),
        );
      return row ?? null;
    },

    /** Attribution lookup by a copy's local row id (`unique (kind, local_id)`). */
    async findMirrorRowByLocal(kind: MirrorRowKind, localId: string): Promise<MirrorRowRow | null> {
      const [row] = await db
        .select()
        .from(mirrorRows)
        .where(and(eq(mirrorRows.kind, kind), eq(mirrorRows.localId, localId)));
      return row ?? null;
    },

    /** All mirror-row links for one copy (attribution overlay on the ledger). */
    async listMirrorRowsForPortfolio(portfolioId: string): Promise<MirrorRowRow[]> {
      return db.select().from(mirrorRows).where(eq(mirrorRows.portfolioId, portfolioId));
    },

    /**
     * Drop one copy's link for a deleted logical entity (a replayed `*.delete`
     * then treats the missing link as already done — design §2 idempotency).
     */
    async deleteMirrorRow(
      kind: MirrorRowKind,
      mirrorId: string,
      portfolioId: string,
    ): Promise<void> {
      await db
        .delete(mirrorRows)
        .where(
          and(
            eq(mirrorRows.kind, kind),
            eq(mirrorRows.mirrorId, mirrorId),
            eq(mirrorRows.portfolioId, portfolioId),
          ),
        );
    },

    /** Re-point a mirror row to a new local id — the tax-immutable correction path (§2). */
    async repointMirrorRow(
      kind: MirrorRowKind,
      mirrorId: string,
      portfolioId: string,
      localId: string,
    ): Promise<void> {
      await db
        .update(mirrorRows)
        .set({ localId })
        .where(
          and(
            eq(mirrorRows.kind, kind),
            eq(mirrorRows.mirrorId, mirrorId),
            eq(mirrorRows.portfolioId, portfolioId),
          ),
        );
    },
  };
}

export type MirrorchainRepository = ReturnType<typeof createMirrorchainRepository>;
