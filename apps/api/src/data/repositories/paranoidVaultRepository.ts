import { and, desc, eq, lt, lte } from 'drizzle-orm';

import {
  VAULT_HISTORY_PAGE_DEFAULT,
  VAULT_HISTORY_PAGE_MAX,
  type PatchParanoidMediaRequest,
  type VaultMediaState,
  type VaultMedium,
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

export interface ParanoidMediaAccountState {
  privacyMode: 'normal' | 'paranoid';
  mediaState: VaultMediaState | null;
}

export type ParanoidMediaPatchResult =
  | { status: 'ok'; state: VaultMediaState; idempotent: boolean }
  | { status: 'not_found' }
  | { status: 'mode_required' }
  | { status: 'state_conflict'; current: VaultMediaState }
  | { status: 'verification_failed'; current: VaultMediaState };

export interface ParanoidMediaPatchInput extends PatchParanoidMediaRequest {
  userId: string;
  now: Date;
}

export interface ParanoidVaultRepository {
  getCurrent(userId: string): Promise<ParanoidVaultRow | null>;
  getMediaState(userId: string): Promise<ParanoidMediaAccountState | null>;
  listHistory(
    userId: string,
    input?: ParanoidVaultHistoryListInput,
  ): Promise<ParanoidVaultHistoryPage>;
  getHistory(userId: string, version: number): Promise<ParanoidVaultHistoryRow | null>;
  compareAndSwap(input: ParanoidVaultCasInput): Promise<ParanoidVaultCasResult>;
  patchMedia(input: ParanoidMediaPatchInput): Promise<ParanoidMediaPatchResult>;
}

function historyPageSize(requested: number | undefined): number {
  if (requested === undefined) return VAULT_HISTORY_PAGE_DEFAULT;
  if (!Number.isSafeInteger(requested) || requested < 1) return VAULT_HISTORY_PAGE_DEFAULT;
  return Math.min(requested, VAULT_HISTORY_PAGE_MAX);
}

export function createParanoidVaultRepository(db: Database): ParanoidVaultRepository {
  return {
    async getCurrent(userId) {
      const [row] = await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, userId));
      return row ?? null;
    },

    async getMediaState(userId) {
      const [row] = await db
        .select({
          privacyMode: users.privacyMode,
          mediaSet: users.paranoidMediaSet,
          driveAttestedVersion: users.paranoidDriveAttestedVersion,
        })
        .from(users)
        .where(eq(users.id, userId));
      return row ? accountMediaState(row) : null;
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

    async patchMedia(input) {
      return db.transaction(async (tx) => {
        const [user] = await tx
          .select({
            privacyMode: users.privacyMode,
            mediaSet: users.paranoidMediaSet,
            driveAttestedVersion: users.paranoidDriveAttestedVersion,
          })
          .from(users)
          .where(eq(users.id, input.userId))
          .for('update');
        if (!user) return { status: 'not_found' } as const;
        const account = accountMediaState(user);
        if (account.privacyMode !== 'paranoid' || account.mediaState === null) {
          return { status: 'mode_required' } as const;
        }
        const current = account.mediaState;

        // A retried request whose first response was lost is harmless: once the
        // exact target is durable, report it without performing another purge.
        if (sameMediaSet(current.mediaSet, input.nextMediaSet)) {
          return { status: 'ok', state: current, idempotent: true } as const;
        }
        if (!sameMediaState(current, input.expected)) {
          return { status: 'state_conflict', current } as const;
        }

        const transition = oneMediumTransition(current.mediaSet, input.nextMediaSet);
        if (transition === null || transition.verifiedMedium !== input.verification.medium) {
          return { status: 'verification_failed', current } as const;
        }

        // Lock the blind server head alongside the account row. Every legal
        // transition has a server copy at verification time: it is the source
        // when adding/removing Drive, or the just-round-tripped target when
        // adding/removing server. This is the authoritative anti-stale check.
        const [serverHead] = await tx
          .select({ version: paranoidVaults.version })
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, input.userId))
          .for('update');
        if (!serverHead || serverHead.version !== input.verification.version) {
          return { status: 'verification_failed', current } as const;
        }
        if (
          current.mediaSet.includes('drive') &&
          current.driveAttestedVersion !== input.verification.version
        ) {
          return { status: 'verification_failed', current } as const;
        }

        const next: VaultMediaState = {
          mediaSet: canonicalMediaSet(input.nextMediaSet),
          driveAttestedVersion: input.nextMediaSet.includes('drive')
            ? input.verification.version
            : null,
        };

        // Removing the server medium is the exact Drive-only boundary. Current
        // and retained ciphertext are deleted in this same transaction as the
        // durable media update, so any SQL failure rolls the entire switch back.
        if (transition.removed === 'server') {
          await tx
            .delete(paranoidVaultHistory)
            .where(eq(paranoidVaultHistory.userId, input.userId));
          await tx.delete(paranoidVaults).where(eq(paranoidVaults.userId, input.userId));
        }
        await tx
          .update(users)
          .set({
            paranoidMediaSet: next.mediaSet,
            paranoidDriveAttestedVersion: next.driveAttestedVersion,
            updatedAt: input.now,
          })
          .where(eq(users.id, input.userId));

        return { status: 'ok', state: next, idempotent: false } as const;
      });
    },
  };
}

function accountMediaState(row: {
  privacyMode: 'normal' | 'paranoid';
  mediaSet: string[] | null;
  driveAttestedVersion: number | null;
}): ParanoidMediaAccountState {
  if (row.privacyMode === 'normal') return { privacyMode: 'normal', mediaState: null };
  const mediaSet = canonicalMediaSet(
    (row.mediaSet ?? []).filter((medium): medium is VaultMedium =>
      (['server', 'drive'] as const).includes(medium as VaultMedium),
    ),
  );
  return {
    privacyMode: 'paranoid',
    mediaState: {
      mediaSet,
      driveAttestedVersion: row.driveAttestedVersion,
    },
  };
}

function canonicalMediaSet(mediaSet: readonly VaultMedium[]): VaultMediaState['mediaSet'] {
  return (['server', 'drive'] as const).filter((medium) => mediaSet.includes(medium));
}

function sameMediaSet(left: readonly VaultMedium[], right: readonly VaultMedium[]): boolean {
  return (
    left.length === right.length &&
    left.every((medium) => right.includes(medium)) &&
    right.every((medium) => left.includes(medium))
  );
}

function sameMediaState(left: VaultMediaState, right: VaultMediaState): boolean {
  return (
    sameMediaSet(left.mediaSet, right.mediaSet) &&
    left.driveAttestedVersion === right.driveAttestedVersion
  );
}

function oneMediumTransition(
  current: readonly VaultMedium[],
  next: readonly VaultMedium[],
): { added: VaultMedium | null; removed: VaultMedium | null; verifiedMedium: VaultMedium } | null {
  const added = next.filter((medium) => !current.includes(medium));
  const removed = current.filter((medium) => !next.includes(medium));
  if (added.length + removed.length !== 1) return null;
  const verifiedMedium = added[0] ?? next[0];
  if (verifiedMedium === undefined) return null;
  return {
    added: added[0] ?? null,
    removed: removed[0] ?? null,
    verifiedMedium,
  };
}
