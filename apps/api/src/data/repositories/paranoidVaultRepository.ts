import { and, desc, eq, isNotNull, isNull, lt, lte } from 'drizzle-orm';

import {
  VAULT_HISTORY_PAGE_DEFAULT,
  VAULT_HISTORY_PAGE_MAX,
  type VaultMediaSet,
} from '@bettertrack/contracts';

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

export interface ParanoidVaultHistoryListInput {
  /** Return versions strictly older than this keyset cursor. */
  cursor?: number;
  /** Requested page size; clamped authoritatively by the repository. */
  limit?: number;
}

export interface ParanoidVaultHistoryMetadataRow {
  version: number;
  sizeBytes: number;
  createdAt: Date;
}

export interface ParanoidVaultHistoryPage {
  items: ParanoidVaultHistoryMetadataRow[];
  nextCursor: number | null;
}

export interface ParanoidVaultMediaSnapshot {
  privacyMode: 'normal' | 'paranoid';
  mediaSet: VaultMediaSet | null;
  driveAttestedVersion: number | null;
  current: ParanoidVaultRow | null;
  /** Highest-version retired ciphertext, including its opaque bytes. */
  retiredHead: ParanoidVaultHistoryRow | null;
}

export interface ParanoidVaultMediaTransitionInput {
  userId: string;
  expectedMediaSet: VaultMediaSet;
  mediaSet: VaultMediaSet;
  driveAttestedVersion: number | null;
  /** The live/staged server version the service verified before this transaction. */
  expectedServerVersion: number;
  now: Date;
}

export type ParanoidVaultMediaTransitionResult =
  | { status: 'ok'; idempotent: boolean }
  | { status: 'not_found' }
  | { status: 'mode_required' }
  | { status: 'precondition_failed'; mediaSet: VaultMediaSet }
  | { status: 'server_version_changed'; currentVersion: number | null };

export interface ParanoidVaultRetiredPurgeInput {
  userId: string;
  proofVersion: number;
  now: Date;
  minRetirementAgeMs: number;
}

export type ParanoidVaultRetiredPurgeResult =
  | { status: 'ok'; purgedVersions: number; purgedBytes: number }
  | { status: 'not_found' }
  | { status: 'mode_required' }
  | { status: 'media_invalid'; mediaSet: VaultMediaSet }
  | { status: 'proof_version_too_old'; latestVersion: number }
  | { status: 'retention_not_met'; eligibleAt: Date }
  | { status: 'unretired_history' };

export interface ParanoidVaultRepository {
  getCurrent(userId: string): Promise<ParanoidVaultRow | null>;
  listHistory(
    userId: string,
    input?: ParanoidVaultHistoryListInput,
  ): Promise<ParanoidVaultHistoryPage>;
  getHistory(userId: string, version: number): Promise<ParanoidVaultHistoryRow | null>;
  getMediaSnapshot(userId: string): Promise<ParanoidVaultMediaSnapshot | null>;
  transitionMedia(
    input: ParanoidVaultMediaTransitionInput,
  ): Promise<ParanoidVaultMediaTransitionResult>;
  purgeRetired(input: ParanoidVaultRetiredPurgeInput): Promise<ParanoidVaultRetiredPurgeResult>;
  compareAndSwap(input: ParanoidVaultCasInput): Promise<ParanoidVaultCasResult>;
}

function historyPageSize(requested: number | undefined): number {
  if (requested === undefined) return VAULT_HISTORY_PAGE_DEFAULT;
  if (!Number.isSafeInteger(requested) || requested < 1) return VAULT_HISTORY_PAGE_DEFAULT;
  return Math.min(requested, VAULT_HISTORY_PAGE_MAX);
}

function sameMediaSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((medium) => right.includes(medium));
}

function storedMediaSet(value: string[] | null): VaultMediaSet | null {
  return value as VaultMediaSet | null;
}

export function createParanoidVaultRepository(db: Database): ParanoidVaultRepository {
  return {
    async getCurrent(userId) {
      const [row] = await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, userId));
      return row ?? null;
    },

    async listHistory(userId, input = {}) {
      const limit = historyPageSize(input.limit);
      const rows = await db
        .select({
          version: paranoidVaultHistory.version,
          sizeBytes: paranoidVaultHistory.sizeBytes,
          createdAt: paranoidVaultHistory.createdAt,
        })
        .from(paranoidVaultHistory)
        .where(
          input.cursor === undefined
            ? eq(paranoidVaultHistory.userId, userId)
            : and(
                eq(paranoidVaultHistory.userId, userId),
                lt(paranoidVaultHistory.version, input.cursor),
              ),
        )
        .orderBy(desc(paranoidVaultHistory.version))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: hasMore ? (items.at(-1)?.version ?? null) : null,
      };
    },

    async getHistory(userId, version) {
      const [row] = await db
        .select()
        .from(paranoidVaultHistory)
        .where(
          and(eq(paranoidVaultHistory.userId, userId), eq(paranoidVaultHistory.version, version)),
        )
        .limit(1);
      return row ?? null;
    },

    async getMediaSnapshot(userId) {
      const [user] = await db
        .select({
          privacyMode: users.privacyMode,
          mediaSet: users.paranoidMediaSet,
          driveAttestedVersion: users.paranoidDriveAttestedVersion,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) return null;

      const [[current], [retiredHead]] = await Promise.all([
        db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, userId)).limit(1),
        db
          .select()
          .from(paranoidVaultHistory)
          .where(
            and(eq(paranoidVaultHistory.userId, userId), isNotNull(paranoidVaultHistory.retiredAt)),
          )
          .orderBy(desc(paranoidVaultHistory.version))
          .limit(1),
      ]);
      return {
        privacyMode: user.privacyMode,
        mediaSet: storedMediaSet(user.mediaSet),
        driveAttestedVersion: user.driveAttestedVersion,
        current: current ?? null,
        retiredHead: retiredHead ?? null,
      };
    },

    async transitionMedia(input) {
      return db.transaction(async (tx) => {
        const [user] = await tx
          .select({
            privacyMode: users.privacyMode,
            mediaSet: users.paranoidMediaSet,
          })
          .from(users)
          .where(eq(users.id, input.userId))
          .for('update');
        if (!user) return { status: 'not_found' } as const;
        if (user.privacyMode !== 'paranoid' || user.mediaSet === null) {
          return { status: 'mode_required' } as const;
        }
        const currentMediaSet = storedMediaSet(user.mediaSet)!;

        // A completed transition is an idempotent retry even when the caller
        // still carries the old expected set.
        if (sameMediaSet(currentMediaSet, input.mediaSet)) {
          return { status: 'ok', idempotent: true } as const;
        }
        if (!sameMediaSet(currentMediaSet, input.expectedMediaSet)) {
          return {
            status: 'precondition_failed',
            mediaSet: currentMediaSet,
          } as const;
        }

        const [current] = await tx
          .select()
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, input.userId))
          .for('update');
        if (!current || current.version !== input.expectedServerVersion) {
          return {
            status: 'server_version_changed',
            currentVersion: current?.version ?? null,
          } as const;
        }

        const removesServer =
          currentMediaSet.includes('server') && !input.mediaSet.includes('server');
        if (removesServer) {
          // The current envelope becomes the newest history candidate, and
          // every previously bounded row joins the same retired recovery set.
          // The live row is removed only after its bytes are durably copied, so
          // this assertion-driven transaction never destroys ciphertext.
          await tx.insert(paranoidVaultHistory).values({
            userId: input.userId,
            version: current.version,
            formatVersion: current.formatVersion,
            sizeBytes: current.sizeBytes,
            blob: current.blob,
            createdAt: current.updatedAt,
            retiredAt: input.now,
          });
          await tx
            .update(paranoidVaultHistory)
            .set({ retiredAt: input.now })
            .where(
              and(
                eq(paranoidVaultHistory.userId, input.userId),
                isNull(paranoidVaultHistory.retiredAt),
              ),
            );
          await tx.delete(paranoidVaults).where(eq(paranoidVaults.userId, input.userId));
        }

        await tx
          .update(users)
          .set({
            paranoidMediaSet: [...input.mediaSet],
            paranoidDriveAttestedVersion: input.driveAttestedVersion,
            updatedAt: input.now,
          })
          .where(eq(users.id, input.userId));
        return { status: 'ok', idempotent: false } as const;
      });
    },

    async purgeRetired(input) {
      return db.transaction(async (tx) => {
        const [user] = await tx
          .select({
            privacyMode: users.privacyMode,
            mediaSet: users.paranoidMediaSet,
          })
          .from(users)
          .where(eq(users.id, input.userId))
          .for('update');
        if (!user) return { status: 'not_found' } as const;
        if (user.privacyMode !== 'paranoid' || user.mediaSet === null) {
          return { status: 'mode_required' } as const;
        }
        const mediaSet = storedMediaSet(user.mediaSet)!;
        if (!sameMediaSet(mediaSet, ['drive'])) {
          return { status: 'media_invalid', mediaSet } as const;
        }

        const rows = await tx
          .select()
          .from(paranoidVaultHistory)
          .where(eq(paranoidVaultHistory.userId, input.userId))
          .orderBy(desc(paranoidVaultHistory.version))
          .for('update');
        if (rows.length === 0) {
          return { status: 'ok', purgedVersions: 0, purgedBytes: 0 } as const;
        }
        if (rows.some((row) => row.retiredAt === null)) {
          return { status: 'unretired_history' } as const;
        }

        const latestVersion = rows[0]!.version;
        if (input.proofVersion < latestVersion) {
          return { status: 'proof_version_too_old', latestVersion } as const;
        }
        const latestRetiredAt = rows.reduce(
          (latest, row) => (row.retiredAt! > latest ? row.retiredAt! : latest),
          rows[0]!.retiredAt!,
        );
        const eligibleAt = new Date(latestRetiredAt.getTime() + input.minRetirementAgeMs);
        if (input.now < eligibleAt) {
          return { status: 'retention_not_met', eligibleAt } as const;
        }

        const purgedBytes = rows.reduce((total, row) => total + row.sizeBytes, 0);
        await tx
          .delete(paranoidVaultHistory)
          .where(
            and(
              eq(paranoidVaultHistory.userId, input.userId),
              isNotNull(paranoidVaultHistory.retiredAt),
            ),
          );
        return {
          status: 'ok',
          purgedVersions: rows.length,
          purgedBytes,
        } as const;
      });
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
              isNull(paranoidVaultHistory.retiredAt),
              lt(paranoidVaultHistory.createdAt, cutoff),
            ),
          );
        // …then the count bound: keep only the newest `maxVersions` archived
        // versions.
        const archived = await tx
          .select({ version: paranoidVaultHistory.version })
          .from(paranoidVaultHistory)
          .where(
            and(eq(paranoidVaultHistory.userId, userId), isNull(paranoidVaultHistory.retiredAt)),
          )
          .orderBy(desc(paranoidVaultHistory.version));
        if (archived.length > retention.maxVersions) {
          const highestToDrop = archived[retention.maxVersions]!.version;
          await tx
            .delete(paranoidVaultHistory)
            .where(
              and(
                eq(paranoidVaultHistory.userId, userId),
                isNull(paranoidVaultHistory.retiredAt),
                lte(paranoidVaultHistory.version, highestToDrop),
              ),
            );
        }
        return { status: 'ok', version: row!.version, updatedAt: row!.updatedAt };
      });
    },
  };
}
