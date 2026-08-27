import { AsyncLocalStorage } from 'node:async_hooks';

import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  assets,
  cashBudgets,
  expenseBudgets,
  importBatches,
  mirrorChainMembers,
  portfolioCashMovements,
  portfolios,
  standingOrders,
  transactions,
  users,
} from '../schema';

export type LockedPrivacyMode = 'normal' | 'paranoid' | null;

interface InProcessLockState {
  readers: number;
  writer: boolean;
  waitingWriters: number;
}

class InProcessPrivacyLocks {
  private readonly states = new Map<string, InProcessLockState>();
  private readonly waiters = new Set<() => void>();

  private state(userId: string): InProcessLockState {
    const existing = this.states.get(userId);
    if (existing) return existing;
    const created = { readers: 0, writer: false, waitingWriters: 0 };
    this.states.set(userId, created);
    return created;
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  private changed(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  async shared<T>(userIds: readonly string[], action: () => Promise<T>): Promise<T> {
    const ids = [...new Set(userIds)].sort();
    while (ids.some((id) => this.state(id).writer || this.state(id).waitingWriters > 0)) {
      await this.wait();
    }
    for (const id of ids) this.state(id).readers += 1;
    try {
      return await action();
    } finally {
      for (const id of ids) this.state(id).readers -= 1;
      this.changed();
    }
  }

  async exclusive<T>(userId: string, action: () => Promise<T>): Promise<T> {
    const state = this.state(userId);
    state.waitingWriters += 1;
    try {
      while (state.writer || state.readers > 0) await this.wait();
      state.writer = true;
    } finally {
      state.waitingWriters -= 1;
    }
    try {
      return await action();
    } finally {
      state.writer = false;
      this.changed();
    }
  }
}

const inProcessLocks = new WeakMap<Database, InProcessPrivacyLocks>();
const heldPrivacyModes = new AsyncLocalStorage<ReadonlyMap<string, LockedPrivacyMode>>();

function testLocksFor(db: Database): InProcessPrivacyLocks {
  const existing = inProcessLocks.get(db);
  if (existing) return existing;
  const created = new InProcessPrivacyLocks();
  inProcessLocks.set(db, created);
  return created;
}

/** Test databases expose one physical connection, so emulate the same lock order in-process. */
export function withExclusiveParanoidTransitionTestLock<T>(
  db: Database,
  userId: string,
  action: () => Promise<T>,
): Promise<T> {
  if (process.env.NODE_ENV !== 'test') return action();
  return testLocksFor(db).exclusive(userId, action);
}

/**
 * Hold KEY SHARE locks on the account rows for the complete duration of a
 * normal-mode action. Paranoid enable takes FOR UPDATE on the same row:
 *
 * - an action that locks first finishes before enable can purge/flip;
 * - enable that locks first commits before the action re-reads the row, so the
 *   action observes `paranoid` and never starts.
 *
 * KEY SHARE is deliberate. It conflicts with the transition's FOR UPDATE but
 * remains compatible with FK checks and non-key account updates performed by
 * the guarded action on another pooled connection.
 *
 * THREE KNOWN LIMITS, all deliberate and all worth reading before trusting a
 * green suite:
 *
 *  1. Under `NODE_ENV=test` the default (PGlite) harness has ONE physical
 *     connection, so a real `FOR KEY SHARE` would self-deadlock. The
 *     in-process reader/writer emulation above preserves the ORDERING the
 *     regressions assert, but it is NOT the production primitive. Vitest keeps
 *     `NODE_ENV=test` even with `TEST_DATABASE_URL`, so real Postgres alone does
 *     not change this branch. The dedicated `paranoidPrivacyLocks.test.ts`
 *     integration suite explicitly selects the production branch and is the
 *     only test suite that exercises the row locks themselves.
 *  2. In production the guarded action runs inside this open transaction, and
 *     several callers perform provider I/O within it (alert quote reads, the
 *     earnings calendar across a whole watchlist, the per-user reminder scan).
 *     That is required by the "hold the guard through response construction"
 *     rule, but it means one idle-in-transaction connection is held for the
 *     duration of upstream latency — bounded by the provider timeouts in
 *     `providers/resilience.ts`.
 *  3. Ids are sorted WITHIN one call, which establishes a global lock order
 *     only for non-nested acquisitions. A guarded action that needs a lock for
 *     an id the outer scope did not take (for example `setAudience` holding
 *     owner + friends, then `emitFollowPublished` guarding a non-friend
 *     follower) opens a SECOND transaction on the lock pool while the first is
 *     still open. `heldPrivacyModes` keeps that re-entrant for ids already
 *     held, so nesting is bounded to at most one extra transaction per request
 *     on the paths that exist today; the quiet failure mode is pool pressure
 *     under N concurrent nested guards, not a deadlock (Postgres would detect a
 *     true cross-transaction cycle). Adding a nested guard on a hot path means
 *     re-checking the dedicated lock pool's size in `server.ts`/`worker.ts`.
 */
export async function withLockedPrivacyModes<T>(
  db: Database,
  userIds: readonly string[],
  run: (modes: ReadonlyMap<string, LockedPrivacyMode>) => Promise<T>,
): Promise<T> {
  const ids = [...new Set(userIds)].sort();
  const alreadyHeld = heldPrivacyModes.getStore() ?? new Map<string, LockedPrivacyMode>();
  const idsToLock = ids.filter((id) => !alreadyHeld.has(id));
  if (idsToLock.length === 0) return run(new Map(alreadyHeld));
  const runWithContext = (modes: ReadonlyMap<string, LockedPrivacyMode>) =>
    heldPrivacyModes.run(modes, () => run(modes));
  if (process.env.NODE_ENV === 'test') {
    return testLocksFor(db).shared(idsToLock, async () => {
      const rows =
        idsToLock.length === 0
          ? []
          : await db
              .select({ id: users.id, privacyMode: users.privacyMode })
              .from(users)
              .where(inArray(users.id, idsToLock))
              .orderBy(asc(users.id));
      const modes = new Map<string, LockedPrivacyMode>(alreadyHeld);
      for (const id of idsToLock) modes.set(id, null);
      for (const row of rows) modes.set(row.id, row.privacyMode);
      return runWithContext(modes);
    });
  }
  return db.transaction(async (tx) => {
    const rows =
      idsToLock.length === 0
        ? []
        : await tx
            .select({ id: users.id, privacyMode: users.privacyMode })
            .from(users)
            .where(inArray(users.id, idsToLock))
            .orderBy(asc(users.id))
            .for('key share');
    const modes = new Map<string, LockedPrivacyMode>(alreadyHeld);
    for (const id of idsToLock) modes.set(id, null);
    for (const row of rows) modes.set(row.id, row.privacyMode);
    return runWithContext(modes);
  });
}

/**
 * Start a genuinely new privacy-lock scope. Detached work spawned while a
 * guarded action is running (for example a live poll timer) inherits Node's
 * AsyncLocalStorage context even after the action releases its database lock;
 * reusing that inherited map would treat a stale mode as still locked. Event
 * consumers use this entry point to discard inherited state and re-read the
 * account under a fresh lock.
 */
export function withFreshLockedPrivacyModes<T>(
  db: Database,
  userIds: readonly string[],
  run: (modes: ReadonlyMap<string, LockedPrivacyMode>) => Promise<T>,
): Promise<T> {
  return heldPrivacyModes.run(new Map(), () => withLockedPrivacyModes(db, userIds, run));
}

/**
 * Hold the account's exclusive transition lock across recovery work executed on
 * another database/Redis/provider stack. The held-mode context makes nested
 * ordinary service guards re-entrant; callers still need an explicit
 * transition-authorized seam for per-portfolio guards while `vault_id` is set.
 */
export function withExclusiveLockedPrivacyMode<T>(
  db: Database,
  userId: string,
  run: (privacyMode: LockedPrivacyMode) => Promise<T>,
): Promise<T> {
  const runWithMode = (privacyMode: LockedPrivacyMode) =>
    heldPrivacyModes.run(new Map([[userId, privacyMode]]), () => run(privacyMode));
  if (process.env.NODE_ENV === 'test') {
    return testLocksFor(db).exclusive(userId, async () => {
      const [row] = await db
        .select({ privacyMode: users.privacyMode })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return runWithMode(row?.privacyMode ?? null);
    });
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ privacyMode: users.privacyMode })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    return runWithMode(row?.privacyMode ?? null);
  });
}

export interface ParanoidOwnedSubject {
  /** False means the id no longer resolves; privacy guards treat that fail-closed. */
  exists: boolean;
  /** Null is valid only for a global market asset. */
  userId: string | null;
  /** Non-null only for a locked per-portfolio vault stub. */
  vaultId: string | null;
}

/**
 * Ownership lookups shared by the API context and worker privacy bindings.
 * Keeping them here avoids duplicating SQL in those two composition roots.
 */
export function createParanoidEnforcementRepository(db: Database) {
  return {
    async portfolioOwner(portfolioId: string): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: portfolios.userId, vaultId: portfolios.vaultId })
        .from(portfolios)
        .where(eq(portfolios.id, portfolioId))
        .limit(1);
      return row
        ? { exists: true, userId: row.userId, vaultId: row.vaultId }
        : { exists: false, userId: null, vaultId: null };
    },

    /**
     * Owner-scoped vault membership lookup for request/service guards. A foreign
     * id deliberately returns `false`, so the underlying operation retains its
     * ordinary owner-scoped 404 instead of becoming a vault-membership oracle.
     */
    async isOwnedPortfolioVaulted(userId: string, portfolioId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(
          and(
            eq(portfolios.id, portfolioId),
            eq(portfolios.userId, userId),
            isNotNull(portfolios.vaultId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /**
     * Conservative quote-capture seam: an asset quote carries no portfolio id,
     * so any vault on the account makes its causal portfolio unknowable.
     */
    async userOwnsVaultedPortfolio(userId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.userId, userId), isNotNull(portfolios.vaultId)))
        .limit(1);
      return row !== undefined;
    },

    /**
     * Resolve an import's destination without touching staged plaintext. The
     * owner predicate preserves the ordinary opaque IMPORT_NOT_FOUND result for
     * a foreign batch while allowing the service proxy to refuse a locked stub
     * before `getBatch` materializes any rows.
     */
    async importBatchPortfolio(userId: string, batchId: string): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: portfolios.userId, vaultId: portfolios.vaultId })
        .from(importBatches)
        .innerJoin(portfolios, eq(importBatches.portfolioId, portfolios.id))
        .where(and(eq(importBatches.id, batchId), eq(importBatches.ownerId, userId)))
        .limit(1);
      return row
        ? { exists: true, userId: row.userId, vaultId: row.vaultId }
        : { exists: false, userId: null, vaultId: null };
    },

    async standingOrderPortfolio(
      userId: string,
      standingOrderId: string,
    ): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: portfolios.userId, vaultId: portfolios.vaultId })
        .from(standingOrders)
        .innerJoin(portfolios, eq(standingOrders.portfolioId, portfolios.id))
        .where(and(eq(standingOrders.id, standingOrderId), eq(standingOrders.userId, userId)))
        .limit(1);
      return row
        ? { exists: true, userId: row.userId, vaultId: row.vaultId }
        : { exists: false, userId: null, vaultId: null };
    },

    async cashBudgetPortfolio(userId: string, budgetId: string): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: portfolios.userId, vaultId: portfolios.vaultId })
        .from(cashBudgets)
        .innerJoin(portfolios, eq(cashBudgets.portfolioId, portfolios.id))
        .where(and(eq(cashBudgets.id, budgetId), eq(portfolios.userId, userId)))
        .limit(1);
      return row
        ? { exists: true, userId: row.userId, vaultId: row.vaultId }
        : { exists: false, userId: null, vaultId: null };
    },

    async cashMovementPortfolio(userId: string, movementId: string): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: portfolios.userId, vaultId: portfolios.vaultId })
        .from(portfolioCashMovements)
        .innerJoin(portfolios, eq(portfolioCashMovements.portfolioId, portfolios.id))
        .where(and(eq(portfolioCashMovements.id, movementId), eq(portfolios.userId, userId)))
        .limit(1);
      return row
        ? { exists: true, userId: row.userId, vaultId: row.vaultId }
        : { exists: false, userId: null, vaultId: null };
    },

    /**
     * Resolve the portfolio represented by each relevant mirror-event
     * principal. Prefer that principal's active membership; after leave,
     * removal, or dissolution, use only their latest ended membership. This
     * deliberately excludes unrelated historical members/forks while keeping
     * queued lifecycle events attributable after their membership tombstone.
     */
    async mirrorMemberPortfolios(chainId: string, principalUserIds: readonly string[]) {
      const userIds = [...new Set(principalUserIds)];
      if (userIds.length === 0) return [];
      const rows = await db
        .select({
          memberUserId: mirrorChainMembers.userId,
          memberPortfolioId: mirrorChainMembers.portfolioId,
          memberStatus: mirrorChainMembers.status,
          memberJoinedAt: mirrorChainMembers.joinedAt,
          memberEndedAt: mirrorChainMembers.endedAt,
          resolvedPortfolioId: portfolios.id,
          portfolioUserId: portfolios.userId,
          portfolioVaultId: portfolios.vaultId,
        })
        .from(mirrorChainMembers)
        .leftJoin(portfolios, eq(mirrorChainMembers.portfolioId, portfolios.id))
        .where(
          and(eq(mirrorChainMembers.chainId, chainId), inArray(mirrorChainMembers.userId, userIds)),
        );

      const currentByUser = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (!row.memberUserId) continue;
        const current = currentByUser.get(row.memberUserId);
        const rowIsActive = row.memberStatus === 'active';
        const currentIsActive = current?.memberStatus === 'active';
        const rowTimestamp = (row.memberEndedAt ?? row.memberJoinedAt).getTime();
        const currentTimestamp = current
          ? (current.memberEndedAt ?? current.memberJoinedAt).getTime()
          : Number.NEGATIVE_INFINITY;
        if (
          !current ||
          (rowIsActive && !currentIsActive) ||
          (rowIsActive === currentIsActive && rowTimestamp > currentTimestamp)
        ) {
          currentByUser.set(row.memberUserId, row);
        }
      }

      return [...currentByUser.values()].map((row) => ({
        memberUserId: row.memberUserId!,
        memberPortfolioId: row.memberPortfolioId,
        portfolio:
          row.resolvedPortfolioId === null
            ? { exists: false, userId: null, vaultId: null }
            : {
                exists: true,
                userId: row.portfolioUserId,
                vaultId: row.portfolioVaultId,
              },
      }));
    },

    /** A dividend event is safe when the recipient still holds the asset in a plain sibling. */
    async userHasPlainHolding(userId: string, assetId: string): Promise<boolean> {
      const signedQuantity = sql<number>`sum(case when ${transactions.side} = 'buy' then ${transactions.quantity} else -${transactions.quantity} end)`;
      const [row] = await db
        .select({ assetId: transactions.assetId })
        .from(transactions)
        .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .where(
          and(
            eq(portfolios.userId, userId),
            eq(transactions.assetId, assetId),
            isNull(portfolios.archivedAt),
            isNull(portfolios.vaultId),
          ),
        )
        .groupBy(transactions.assetId)
        .having(gt(signedQuantity, sql`0`))
        .limit(1);
      return row !== undefined;
    },

    /** Pre-cash-fusion budget events are account-common and remain deliverable. */
    async legacyExpenseBudgetExists(userId: string, budgetId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: expenseBudgets.id })
        .from(expenseBudgets)
        .where(and(eq(expenseBudgets.id, budgetId), eq(expenseBudgets.userId, userId)))
        .limit(1);
      return row !== undefined;
    },

    async assetOwner(assetId: string): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: assets.ownerId })
        .from(assets)
        .where(eq(assets.id, assetId))
        .limit(1);
      return row
        ? { exists: true, userId: row.userId, vaultId: null }
        : { exists: false, userId: null, vaultId: null };
    },
  };
}

export type ParanoidEnforcementRepository = ReturnType<typeof createParanoidEnforcementRepository>;
