import { and, desc, eq, lt, lte } from 'drizzle-orm';

import {
  VAULT_HISTORY_PAGE_DEFAULT,
  VAULT_HISTORY_PAGE_MAX,
  type PrepareParanoidMediaVerificationRequest,
  type PatchParanoidMediaRequest,
  type VaultMediaState,
  type VaultMediaVerificationClaim,
  type VaultMedium,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  paranoidRehydrationReceipts,
  paranoidVaultHistory,
  paranoidVaultServerCandidates,
  paranoidVaults,
  users,
  type ParanoidVaultHistoryRow,
  type ParanoidVaultRow,
  type ParanoidVaultServerCandidateRow,
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
      await executor
        .delete(paranoidVaultServerCandidates)
        .where(eq(paranoidVaultServerCandidates.userId, userId));
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
  | { status: 'precondition_failed'; currentVersion: number | null }
  | { status: 'medium_inactive' };

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

export interface ParanoidMediaPatchInput extends Omit<PatchParanoidMediaRequest, 'verification'> {
  userId: string;
  verification: VaultMediaVerificationClaim;
  /** Set only after the service validates the signed proof against this request. */
  proofVerified: true;
  now: Date;
}

export interface ParanoidMediaVerificationInput extends PrepareParanoidMediaVerificationRequest {
  userId: string;
  now: Date;
}

export type ParanoidMediaVerificationResult =
  | { status: 'ok'; current: VaultMediaState }
  | Exclude<ParanoidMediaPatchResult, { status: 'ok' }>;

export interface ParanoidStageServerCandidateInput extends ParanoidVaultBlobInput {
  userId: string;
  expiresAt: Date;
  now: Date;
}

export type ParanoidStageServerCandidateResult =
  | { status: 'ok'; candidate: ParanoidVaultServerCandidateRow; idempotent: boolean }
  | { status: 'not_found' }
  | { status: 'mode_required' }
  | { status: 'state_conflict'; current: VaultMediaState }
  | { status: 'verification_failed'; current: VaultMediaState };

export interface ParanoidVaultRepository {
  getCurrent(userId: string): Promise<ParanoidVaultRow | null>;
  getMediaState(userId: string): Promise<ParanoidMediaAccountState | null>;
  listHistory(
    userId: string,
    input?: ParanoidVaultHistoryListInput,
  ): Promise<ParanoidVaultHistoryPage>;
  getHistory(userId: string, version: number): Promise<ParanoidVaultHistoryRow | null>;
  compareAndSwap(input: ParanoidVaultCasInput): Promise<ParanoidVaultCasResult>;
  verifyMediaTransition(
    input: ParanoidMediaVerificationInput,
  ): Promise<ParanoidMediaVerificationResult>;
  patchMedia(input: ParanoidMediaPatchInput): Promise<ParanoidMediaPatchResult>;
  stageServerCandidate(
    input: ParanoidStageServerCandidateInput,
  ): Promise<ParanoidStageServerCandidateResult>;
  getServerCandidate(
    userId: string,
    candidateId: string,
    now: Date,
  ): Promise<ParanoidVaultServerCandidateRow | null>;
  discardServerCandidate(userId: string, candidateId: string): Promise<void>;
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
        // Serialize every server-byte mutation with media switching. A
        // Drive-only account must remain physically byte-free server-side; the
        // dedicated atomic add-server operation below is the only way to make
        // this medium active again.
        const [owner] = await tx
          .select({
            privacyMode: users.privacyMode,
            mediaSet: users.paranoidMediaSet,
          })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (owner?.privacyMode === 'paranoid' && !(owner.mediaSet ?? []).includes('server')) {
          return { status: 'medium_inactive' } as const;
        }

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

    async verifyMediaTransition(input) {
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
        if (!sameMediaState(current, input.expected)) {
          return { status: 'state_conflict', current } as const;
        }

        const sameSet = sameMediaSet(current.mediaSet, input.nextMediaSet);
        const transition = sameSet
          ? null
          : oneMediumTransition(current.mediaSet, input.nextMediaSet);
        const validClaim = sameSet
          ? current.mediaSet.includes('drive') && input.verification.medium === 'drive'
          : transition !== null && transition.verifiedMedium === input.verification.medium;
        if (!validClaim) {
          return { status: 'verification_failed', current } as const;
        }
        if (
          transition?.removed === 'server' &&
          current.driveAttestedVersion !== input.verification.version
        ) {
          return { status: 'verification_failed', current } as const;
        }

        // Adding server is the one transition whose authenticated target is not
        // live yet. Bind the proof to the exact unexpired staged row the browser
        // read back; every other transition remains bound to the locked live
        // server head. A candidate id is invalid outside that one transition.
        if (transition?.added === 'server') {
          const candidateId = input.verification.serverCandidateId;
          if (!candidateId) return { status: 'verification_failed', current } as const;
          const [candidate] = await tx
            .select()
            .from(paranoidVaultServerCandidates)
            .where(
              and(
                eq(paranoidVaultServerCandidates.userId, input.userId),
                eq(paranoidVaultServerCandidates.id, candidateId),
              ),
            )
            .for('update');
          if (candidate && candidate.expiresAt.getTime() <= input.now.getTime()) {
            await tx
              .delete(paranoidVaultServerCandidates)
              .where(eq(paranoidVaultServerCandidates.id, candidate.id));
            return { status: 'verification_failed', current } as const;
          }
          const [serverHead] = await tx
            .select({ version: paranoidVaults.version })
            .from(paranoidVaults)
            .where(eq(paranoidVaults.userId, input.userId))
            .for('update');
          if (serverHead || !candidate || candidate.version !== input.verification.version) {
            return { status: 'verification_failed', current } as const;
          }
        } else {
          if (input.verification.serverCandidateId !== undefined) {
            return { status: 'verification_failed', current } as const;
          }
          // The API-issued proof is server-verifiable transition
          // authorization, not a bare PATCH claim. Drive remains
          // client-attested by binding design.
          const [serverHead] = await tx
            .select({ version: paranoidVaults.version })
            .from(paranoidVaults)
            .where(eq(paranoidVaults.userId, input.userId))
            .for('update');
          if (!serverHead || serverHead.version !== input.verification.version) {
            return { status: 'verification_failed', current } as const;
          }
        }
        return { status: 'ok', current } as const;
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

        if (!sameMediaState(current, input.expected)) {
          return { status: 'state_conflict', current } as const;
        }

        // A retried request whose first response was lost is harmless: once the
        // exact target and attestation are durable, report it without performing
        // another purge. A same-set request with a NEW Drive version is instead
        // the normal post-replication attestation refresh.
        const sameSet = sameMediaSet(current.mediaSet, input.nextMediaSet);
        if (
          sameSet &&
          (!current.mediaSet.includes('drive') ||
            current.driveAttestedVersion === input.verification.version)
        ) {
          return { status: 'ok', state: current, idempotent: true } as const;
        }

        const transition = sameSet
          ? null
          : oneMediumTransition(current.mediaSet, input.nextMediaSet);
        const validClaim = sameSet
          ? current.mediaSet.includes('drive') && input.verification.medium === 'drive'
          : transition !== null && transition.verifiedMedium === input.verification.medium;
        if (!input.proofVerified || !validClaim) {
          return { status: 'verification_failed', current } as const;
        }

        let serverCandidate: ParanoidVaultServerCandidateRow | undefined;
        if (transition?.added === 'server') {
          const candidateId = input.verification.serverCandidateId;
          if (!candidateId) return { status: 'verification_failed', current } as const;
          [serverCandidate] = await tx
            .select()
            .from(paranoidVaultServerCandidates)
            .where(
              and(
                eq(paranoidVaultServerCandidates.userId, input.userId),
                eq(paranoidVaultServerCandidates.id, candidateId),
              ),
            )
            .for('update');
          if (serverCandidate && serverCandidate.expiresAt.getTime() <= input.now.getTime()) {
            await tx
              .delete(paranoidVaultServerCandidates)
              .where(eq(paranoidVaultServerCandidates.id, serverCandidate.id));
            return { status: 'verification_failed', current } as const;
          }
          const [liveServerHead] = await tx
            .select({ version: paranoidVaults.version })
            .from(paranoidVaults)
            .where(eq(paranoidVaults.userId, input.userId))
            .for('update');
          if (
            liveServerHead ||
            !serverCandidate ||
            serverCandidate.version !== input.verification.version
          ) {
            return { status: 'verification_failed', current } as const;
          }
        } else {
          if (input.verification.serverCandidateId !== undefined) {
            return { status: 'verification_failed', current } as const;
          }
          // Every other legal transition is bound to the locked live server
          // head: it is the source when adding Drive and the freshly verified
          // copy when removing either medium.
          const [serverHead] = await tx
            .select({ version: paranoidVaults.version })
            .from(paranoidVaults)
            .where(eq(paranoidVaults.userId, input.userId))
            .for('update');
          if (!serverHead || serverHead.version !== input.verification.version) {
            return { status: 'verification_failed', current } as const;
          }
        }
        if (
          transition?.removed === 'server' &&
          current.driveAttestedVersion !== input.verification.version
        ) {
          return { status: 'verification_failed', current } as const;
        }

        const next: VaultMediaState = {
          mediaSet: canonicalMediaSet(input.nextMediaSet),
          driveAttestedVersion: !input.nextMediaSet.includes('drive')
            ? null
            : transition?.added === 'drive'
              ? current.driveAttestedVersion
              : input.verification.version,
        };

        // Removing the server medium is the exact Drive-only boundary. Current
        // and retained ciphertext are deleted in this same transaction as the
        // durable media update, so any SQL failure rolls the entire switch back.
        if (transition?.removed === 'server') {
          await tx
            .delete(paranoidVaultHistory)
            .where(eq(paranoidVaultHistory.userId, input.userId));
          await tx.delete(paranoidVaults).where(eq(paranoidVaults.userId, input.userId));
        }
        if (serverCandidate) {
          await tx.insert(paranoidVaults).values({
            userId: input.userId,
            version: serverCandidate.version,
            formatVersion: serverCandidate.formatVersion,
            sizeBytes: serverCandidate.sizeBytes,
            blob: serverCandidate.blob,
            createdAt: input.now,
            updatedAt: input.now,
          });
          await tx
            .delete(paranoidVaultServerCandidates)
            .where(eq(paranoidVaultServerCandidates.id, serverCandidate.id));
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

    async stageServerCandidate(input) {
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
        const [serverHead] = await tx
          .select({ version: paranoidVaults.version })
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, input.userId))
          .for('update');
        if (!sameMediaSet(current.mediaSet, ['drive'])) {
          return { status: 'state_conflict', current } as const;
        }
        if (
          serverHead ||
          (current.driveAttestedVersion !== null && input.version < current.driveAttestedVersion)
        ) {
          return { status: 'verification_failed', current } as const;
        }

        let [candidate] = await tx
          .select()
          .from(paranoidVaultServerCandidates)
          .where(eq(paranoidVaultServerCandidates.userId, input.userId))
          .for('update');
        if (candidate && candidate.expiresAt.getTime() <= input.now.getTime()) {
          await tx
            .delete(paranoidVaultServerCandidates)
            .where(eq(paranoidVaultServerCandidates.id, candidate.id));
          candidate = undefined;
        }
        if (
          candidate &&
          candidate.version === input.version &&
          candidate.formatVersion === input.formatVersion &&
          candidate.sizeBytes === input.sizeBytes &&
          candidate.blob.equals(input.blob)
        ) {
          return { status: 'ok', candidate, idempotent: true } as const;
        }
        if (candidate) {
          await tx
            .delete(paranoidVaultServerCandidates)
            .where(eq(paranoidVaultServerCandidates.id, candidate.id));
        }
        const [staged] = await tx
          .insert(paranoidVaultServerCandidates)
          .values({
            userId: input.userId,
            version: input.version,
            formatVersion: input.formatVersion,
            sizeBytes: input.sizeBytes,
            blob: input.blob,
            createdAt: input.now,
            expiresAt: input.expiresAt,
          })
          .returning();
        return { status: 'ok', candidate: staged!, idempotent: false } as const;
      });
    },

    async getServerCandidate(userId, candidateId, now) {
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(paranoidVaultServerCandidates)
          .where(
            and(
              eq(paranoidVaultServerCandidates.userId, userId),
              eq(paranoidVaultServerCandidates.id, candidateId),
            ),
          )
          .for('update');
        if (!candidate) return null;
        if (candidate.expiresAt.getTime() <= now.getTime()) {
          await tx
            .delete(paranoidVaultServerCandidates)
            .where(eq(paranoidVaultServerCandidates.id, candidate.id));
          return null;
        }
        return candidate;
      });
    },

    async discardServerCandidate(userId, candidateId) {
      await db
        .delete(paranoidVaultServerCandidates)
        .where(
          and(
            eq(paranoidVaultServerCandidates.userId, userId),
            eq(paranoidVaultServerCandidates.id, candidateId),
          ),
        );
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
