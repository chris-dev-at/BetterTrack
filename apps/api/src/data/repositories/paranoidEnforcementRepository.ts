import { AsyncLocalStorage } from 'node:async_hooks';

import { asc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, portfolios, users } from '../schema';

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
 * TWO KNOWN LIMITS, both deliberate and both worth reading before trusting a
 * green suite:
 *
 *  1. Under `NODE_ENV=test` the default (PGlite) harness has ONE physical
 *     connection, so a real `FOR KEY SHARE` would self-deadlock. The
 *     in-process reader/writer emulation above preserves the ORDERING the
 *     regressions assert, but it is NOT the production primitive — only the
 *     integration mode (`TEST_DATABASE_URL`, real Postgres 17) exercises the
 *     row locks themselves.
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

export interface ParanoidOwnedSubject {
  /** False means the id no longer resolves; privacy guards treat that fail-closed. */
  exists: boolean;
  /** Null is valid only for a global market asset. */
  userId: string | null;
}

/**
 * Ownership lookups shared by the API context and worker privacy bindings.
 * Keeping them here avoids duplicating SQL in those two composition roots.
 */
export function createParanoidEnforcementRepository(db: Database) {
  return {
    async portfolioOwner(portfolioId: string): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: portfolios.userId })
        .from(portfolios)
        .where(eq(portfolios.id, portfolioId))
        .limit(1);
      return row ? { exists: true, userId: row.userId } : { exists: false, userId: null };
    },

    async assetOwner(assetId: string): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: assets.ownerId })
        .from(assets)
        .where(eq(assets.id, assetId))
        .limit(1);
      return row ? { exists: true, userId: row.userId } : { exists: false, userId: null };
    },
  };
}

export type ParanoidEnforcementRepository = ReturnType<typeof createParanoidEnforcementRepository>;
