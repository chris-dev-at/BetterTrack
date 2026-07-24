import { and, desc, eq, lt, lte } from 'drizzle-orm';

import type { Database } from '../db';
import {
  paranoidRehydrationReceipts,
  paranoidVaultHistory,
  paranoidVaults,
  users,
  type ParanoidVaultHistoryRow,
  type ParanoidVaultRow,
} from '../schema';

/**
 * Transaction-bound rehydration primitives. The service receives this executor
 * from its sole `db.transaction` callback, so none of these operations can open
 * an independent transaction or emit an external effect.
 */
export interface ParanoidRehydrationTransactionRepository {
  getState(userId: string): Promise<{
    privacyMode: 'normal' | 'paranoid';
    receipt: { rehydrationId: string; completedAt: Date } | null;
  } | null>;
  insertReceipt(userId: string, rehydrationId: string, completedAt: Date): Promise<void>;
  setNormalAndClearMedia(userId: string): Promise<void>;
  deleteServerCiphertext(userId: string): Promise<void>;
}

export function createParanoidRehydrationTransactionRepository(
  executor: Pick<Database, 'select' | 'insert' | 'update' | 'delete'>,
): ParanoidRehydrationTransactionRepository {
  return {
    async getState(userId) {
      const [user] = await executor
        .select({ privacyMode: users.privacyMode })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!user) return null;
      const [receipt] = await executor
        .select({
          rehydrationId: paranoidRehydrationReceipts.rehydrationId,
          completedAt: paranoidRehydrationReceipts.completedAt,
        })
        .from(paranoidRehydrationReceipts)
        .where(eq(paranoidRehydrationReceipts.userId, userId));
      return { privacyMode: user.privacyMode, receipt: receipt ?? null };
    },

    async insertReceipt(userId, rehydrationId, completedAt) {
      await executor
        .insert(paranoidRehydrationReceipts)
        .values({ userId, rehydrationId, completedAt });
    },

    async setNormalAndClearMedia(userId) {
      await executor
        .update(users)
        .set({
          privacyMode: 'normal',
          paranoidMediaSet: null,
          paranoidDriveAttestedVersion: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    },

    async deleteServerCiphertext(userId) {
      await executor.delete(paranoidVaultHistory).where(eq(paranoidVaultHistory.userId, userId));
      await executor.delete(paranoidVaults).where(eq(paranoidVaults.userId, userId));
    },
  };
}

/**
 * Full transaction entry point for the rehydration service. It intentionally
 * exposes the raw executor only to its caller, keeping the service's scope to one
 * database transaction while the normal write services remain unchanged.
 */
export async function withParanoidRehydrationTransaction<T>(
  db: Database,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction((tx) => run(tx as unknown as Database));
}

/**
 * Paranoid-vault persistence (§13.5 V5-P13 arc b, `docs/paranoid-design.md` §2,
 * §4). The BetterTrack `server` medium of a paranoid account's client-encrypted
 * vault — a BLIND blob store with compare-and-swap. The repository stores the
 * opaque envelope bytes + the minimum CAS/version metadata and never inspects
 * the payload.
 *
 * `compareAndSwap` runs the whole CAS atomically under the vault row's lock:
 * the current row is `SELECT … FOR UPDATE`-locked, the precondition is checked,
 * the superseded blob is archived to the bounded history, the live row is
 * replaced, and the history is pruned — so two concurrent writers can never both
 * win and newer ciphertext is never overwritten by a stale one.
 */

export interface ParanoidVaultBlobInput {
  /** Monotonic CAS token carried by the new envelope header. */
  version: number;
  /** Envelope layout version read from the header. */
  formatVersion: number;
  /** Ciphertext envelope byte length (the size-cap guard reads it). */
  sizeBytes: number;
  /** The opaque envelope bytes. */
  blob: Buffer;
}

export interface ParanoidVaultRetention {
  /** Keep at most this many archived versions. */
  maxVersions: number;
  /** Drop archived versions older than this age. */
  maxAgeMs: number;
}

export interface ParanoidVaultCasInput extends ParanoidVaultBlobInput {
  userId: string;
  /**
   * The CAS precondition: the version the caller expects to be current, or
   * `null` to CREATE (first write — succeeds only when no vault exists yet).
   */
  expectedVersion: number | null;
  retention: ParanoidVaultRetention;
  /** Injected clock (archive/prune timestamps) so tests stay deterministic. */
  now: Date;
}

export type ParanoidVaultCasResult =
  | { status: 'ok'; version: number; updatedAt: Date }
  | { status: 'precondition_failed'; currentVersion: number | null };

export interface ParanoidVaultRepository {
  getCurrent(userId: string): Promise<ParanoidVaultRow | null>;
  listHistory(userId: string): Promise<ParanoidVaultHistoryRow[]>;
  compareAndSwap(input: ParanoidVaultCasInput): Promise<ParanoidVaultCasResult>;
}

export function createParanoidVaultRepository(db: Database): ParanoidVaultRepository {
  return {
    async getCurrent(userId) {
      const [row] = await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, userId));
      return row ?? null;
    },

    async listHistory(userId) {
      return db
        .select()
        .from(paranoidVaultHistory)
        .where(eq(paranoidVaultHistory.userId, userId))
        .orderBy(desc(paranoidVaultHistory.version));
    },

    async compareAndSwap(input) {
      const { userId, expectedVersion, version, formatVersion, sizeBytes, blob, retention, now } =
        input;
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, userId))
          .for('update');

        if (expectedVersion === null) {
          // Create path (first write). Succeeds only when no vault exists yet;
          // onConflictDoNothing turns a concurrent double-create into a clean
          // precondition failure instead of a unique-violation throw.
          if (current) {
            return { status: 'precondition_failed', currentVersion: current.version };
          }
          const inserted = await tx
            .insert(paranoidVaults)
            .values({
              userId,
              version,
              formatVersion,
              sizeBytes,
              blob,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing()
            .returning();
          if (inserted.length === 0) {
            const [raced] = await tx
              .select({ version: paranoidVaults.version })
              .from(paranoidVaults)
              .where(eq(paranoidVaults.userId, userId));
            return { status: 'precondition_failed', currentVersion: raced?.version ?? null };
          }
          return { status: 'ok', version: inserted[0]!.version, updatedAt: inserted[0]!.updatedAt };
        }

        // Replace path. The supplied version must exactly match the current one.
        if (!current || current.version !== expectedVersion) {
          return { status: 'precondition_failed', currentVersion: current?.version ?? null };
        }

        // Archive the superseded blob, replace the live row, prune the history.
        await tx
          .insert(paranoidVaultHistory)
          .values({
            userId,
            version: current.version,
            formatVersion: current.formatVersion,
            sizeBytes: current.sizeBytes,
            blob: current.blob,
            createdAt: now,
          })
          .onConflictDoNothing();
        const [row] = await tx
          .update(paranoidVaults)
          .set({ version, formatVersion, sizeBytes, blob, updatedAt: now })
          .where(eq(paranoidVaults.userId, userId))
          .returning();

        // Prune the bounded history (§4). Age bound first: drop everything
        // archived before the cutoff…
        const cutoff = new Date(now.getTime() - retention.maxAgeMs);
        await tx
          .delete(paranoidVaultHistory)
          .where(
            and(
              eq(paranoidVaultHistory.userId, userId),
              lt(paranoidVaultHistory.createdAt, cutoff),
            ),
          );
        // …then the count bound: keep only the newest `maxVersions` archived
        // versions.
        const archived = await tx
          .select({ version: paranoidVaultHistory.version })
          .from(paranoidVaultHistory)
          .where(eq(paranoidVaultHistory.userId, userId))
          .orderBy(desc(paranoidVaultHistory.version));
        if (archived.length > retention.maxVersions) {
          const highestToDrop = archived[retention.maxVersions]!.version;
          await tx
            .delete(paranoidVaultHistory)
            .where(
              and(
                eq(paranoidVaultHistory.userId, userId),
                lte(paranoidVaultHistory.version, highestToDrop),
              ),
            );
        }
        return { status: 'ok', version: row!.version, updatedAt: row!.updatedAt };
      });
    },
  };
}
