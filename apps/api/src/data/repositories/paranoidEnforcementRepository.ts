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
const heldPrivacyLocks = new AsyncLocalStorage<ReadonlySet<string>>();

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
 */
export async function withLockedPrivacyModes<T>(
  db: Database,
  userIds: readonly string[],
  run: (modes: ReadonlyMap<string, LockedPrivacyMode>) => Promise<T>,
): Promise<T> {
  const ids = [...new Set(userIds)].sort();
  const alreadyHeld = heldPrivacyLocks.getStore() ?? new Set<string>();
  const idsToLock = ids.filter((id) => !alreadyHeld.has(id));
  const heldModes = new Map<string, LockedPrivacyMode>(ids.map((id) => [id, 'normal']));
  if (idsToLock.length === 0) return run(heldModes);
  const runWithContext = (modes: ReadonlyMap<string, LockedPrivacyMode>) =>
    heldPrivacyLocks.run(new Set([...alreadyHeld, ...idsToLock]), () => run(modes));
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
      const modes = new Map<string, LockedPrivacyMode>(heldModes);
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
    const modes = new Map<string, LockedPrivacyMode>(heldModes);
    for (const id of idsToLock) modes.set(id, null);
    for (const row of rows) modes.set(row.id, row.privacyMode);
    return runWithContext(modes);
  });
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
