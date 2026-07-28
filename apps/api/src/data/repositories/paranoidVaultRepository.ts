import { and, desc, eq, lt, lte } from 'drizzle-orm';

import {
  VAULT_HISTORY_PAGE_DEFAULT,
  VAULT_HISTORY_PAGE_MAX,
  VAULT_RETIRED_SERVER_MIN_RETENTION_MS,
  type ParanoidMediaStateResponse,
  type ParanoidMediaTransitionRequest,
  type ParanoidVaultMediaState,
  type VaultMediaSelection,
  type VaultMediaSet,
  type VaultMedium,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  paranoidRehydrationReceipts,
  paranoidVaultHistory,
  paranoidVaultRetired,
  paranoidVaultRetirements,
  paranoidVaultServerCandidates,
  paranoidVaults,
  users,
  type ParanoidVaultHistoryRow,
  type ParanoidVaultRetiredRow,
  type ParanoidVaultRetirementRow,
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
  executor: Database,
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
        .where(eq(paranoidRehydrationReceipts.userId, userId))
        .for('update');
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
      await executor.delete(paranoidVaultRetired).where(eq(paranoidVaultRetired.userId, userId));
      await executor
        .delete(paranoidVaultRetirements)
        .where(eq(paranoidVaultRetirements.userId, userId));
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

/** Opaque active/candidate blob fields; no caller may inspect the payload. */
export interface ParanoidVaultBlobInput {
  version: number;
  formatVersion: number;
  sizeBytes: number;
  blob: Buffer;
}

export interface ParanoidVaultRetention {
  maxVersions: number;
  maxAgeMs: number;
}

export interface ParanoidVaultCasInput extends ParanoidVaultBlobInput {
  userId: string;
  expectedVersion: number | null;
  retention: ParanoidVaultRetention;
  now: Date;
  /**
   * Immutable verifier accepted on the first active write, or once on the next
   * CAS update of a legacy keyless active vault.
   */
  retirementProofPublicKey?: string | null;
}

export type ParanoidVaultCasResult =
  | { status: 'ok'; version: number; updatedAt: Date }
  | { status: 'precondition_failed'; currentVersion: number | null }
  | { status: 'medium_inactive' }
  | { status: 'proof_key_conflict' };

export interface ParanoidVaultHistoryListInput {
  cursor?: number;
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

export type ParanoidVaultHistoryReadRow = ParanoidVaultHistoryRow | ParanoidVaultRetiredRow;

export interface ParanoidMediaAccountState {
  privacyMode: 'normal' | 'paranoid';
  mediaState: ParanoidVaultMediaState | null;
}

export interface ParanoidStageServerCandidateInput extends ParanoidVaultBlobInput {
  userId: string;
  expiresAt: Date;
  now: Date;
  retirementProofPublicKey: string | null;
}

export type ParanoidStageServerCandidateResult =
  | { status: 'ok'; candidate: ParanoidVaultServerCandidateRow; idempotent: boolean }
  | { status: 'not_found' }
  | { status: 'mode_required' }
  | { status: 'state_conflict'; current: ParanoidVaultMediaState }
  | { status: 'verification_failed'; current: ParanoidVaultMediaState }
  | { status: 'proof_key_conflict'; current: ParanoidVaultMediaState };

export interface ParanoidMediaTransitionInput extends ParanoidMediaTransitionRequest {
  userId: string;
  /** The service has checked the signed receipt issued on candidate read-back. */
  candidateReadbackVerified: boolean;
  now: Date;
}

export type ParanoidMediaTransitionResult =
  | { status: 'ok'; state: ParanoidVaultMediaState; idempotent: boolean }
  | { status: 'not_found' }
  | { status: 'mode_required' }
  | { status: 'state_conflict'; current: ParanoidVaultMediaState }
  | { status: 'verification_failed'; current: ParanoidVaultMediaState }
  | { status: 'proof_required'; current: ParanoidVaultMediaState }
  | { status: 'proof_key_conflict'; current: ParanoidVaultMediaState }
  | { status: 'retirement_conflict'; current: ParanoidVaultMediaState };

export interface ParanoidRetirementState {
  retiredVersion: number;
  retirementProofPublicKey: string;
  retiredAt: Date;
}

export interface ParanoidRetiredPurgeInput {
  userId: string;
  retiredVersion: number;
  /** Literal marker prevents direct repository callers from accidentally bypassing service proof checks. */
  proofVerified: true;
  now: Date;
}

export type ParanoidRetiredPurgeResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'mode_required' }
  | { status: 'state_conflict'; current: ParanoidVaultMediaState }
  | { status: 'retention_pending'; purgeAfter: Date }
  | { status: 'proof_required' };

export interface ParanoidVaultRepository {
  getCurrent(userId: string): Promise<ParanoidVaultRow | null>;
  getMediaState(userId: string): Promise<ParanoidMediaStateResponse | null>;
  listHistory(
    userId: string,
    input?: ParanoidVaultHistoryListInput,
  ): Promise<ParanoidVaultHistoryPage>;
  getHistory(userId: string, version: number): Promise<ParanoidVaultHistoryReadRow | null>;
  compareAndSwap(input: ParanoidVaultCasInput): Promise<ParanoidVaultCasResult>;
  stageServerCandidate(
    input: ParanoidStageServerCandidateInput,
  ): Promise<ParanoidStageServerCandidateResult>;
  getServerCandidate(
    userId: string,
    candidateId: string,
    now: Date,
  ): Promise<ParanoidVaultServerCandidateRow | null>;
  transitionMedia(input: ParanoidMediaTransitionInput): Promise<ParanoidMediaTransitionResult>;
  getRetirementState(userId: string): Promise<ParanoidRetirementState | null>;
  purgeRetired(input: ParanoidRetiredPurgeInput): Promise<ParanoidRetiredPurgeResult>;
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
      return db.transaction(async (tx) => {
        // Media writers take this same account lock. Keeping state reporting in
        // the transaction means an expired staged ciphertext is physically
        // disposed before the client observes that it has no candidate to
        // recover, rather than being merely hidden in the response.
        const [user] = await tx
          .select({
            privacyMode: users.privacyMode,
            mediaSet: users.paranoidMediaSet,
            driveAttestedVersion: users.paranoidDriveAttestedVersion,
          })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!user) return null;
        if (user.privacyMode === 'normal') return { privacyMode: 'normal', mediaState: null };

        const now = new Date();
        const [active] = await tx
          .select()
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, userId))
          .limit(1);
        let [candidate] = await tx
          .select()
          .from(paranoidVaultServerCandidates)
          .where(eq(paranoidVaultServerCandidates.userId, userId))
          .for('update');
        if (candidate && candidate.expiresAt.getTime() <= now.getTime()) {
          await tx
            .delete(paranoidVaultServerCandidates)
            .where(eq(paranoidVaultServerCandidates.id, candidate.id));
          candidate = undefined;
        }
        const [retirement] = await tx
          .select()
          .from(paranoidVaultRetirements)
          .where(eq(paranoidVaultRetirements.userId, userId))
          .limit(1);
        return {
          privacyMode: 'paranoid',
          mediaState: mediaStateOf(
            mediaSelectionOf(user),
            Boolean(active),
            candidate ?? null,
            retirement ?? null,
          ),
        };
      });
    },

    async listHistory(userId, input = {}) {
      const limit = historyPageSize(input.limit);
      const whereHistory =
        input.cursor === undefined
          ? eq(paranoidVaultHistory.userId, userId)
          : and(
              eq(paranoidVaultHistory.userId, userId),
              lt(paranoidVaultHistory.version, input.cursor),
            );
      const whereRetired =
        input.cursor === undefined
          ? eq(paranoidVaultRetired.userId, userId)
          : and(
              eq(paranoidVaultRetired.userId, userId),
              lt(paranoidVaultRetired.version, input.cursor),
            );
      const [historyRows, retiredRows] = await Promise.all([
        db
          .select({
            version: paranoidVaultHistory.version,
            sizeBytes: paranoidVaultHistory.sizeBytes,
            createdAt: paranoidVaultHistory.createdAt,
          })
          .from(paranoidVaultHistory)
          .where(whereHistory)
          .orderBy(desc(paranoidVaultHistory.version))
          .limit(limit + 1),
        db
          .select({
            version: paranoidVaultRetired.version,
            sizeBytes: paranoidVaultRetired.sizeBytes,
            createdAt: paranoidVaultRetired.createdAt,
          })
          .from(paranoidVaultRetired)
          .where(whereRetired)
          .orderBy(desc(paranoidVaultRetired.version))
          .limit(limit + 1),
      ]);
      const byVersion = new Map<number, ParanoidVaultHistoryMetadataRow>();
      for (const row of retiredRows) byVersion.set(row.version, row);
      for (const row of historyRows) byVersion.set(row.version, row);
      const combined = [...byVersion.values()].sort((left, right) => right.version - left.version);
      const items = combined.slice(0, limit);
      return {
        items,
        nextCursor:
          combined.length > limit || historyRows.length > limit || retiredRows.length > limit
            ? (items.at(-1)?.version ?? null)
            : null,
      };
    },

    async getHistory(userId, version) {
      const [history] = await db
        .select()
        .from(paranoidVaultHistory)
        .where(
          and(eq(paranoidVaultHistory.userId, userId), eq(paranoidVaultHistory.version, version)),
        )
        .limit(1);
      if (history) return history;
      const [retired] = await db
        .select()
        .from(paranoidVaultRetired)
        .where(
          and(eq(paranoidVaultRetired.userId, userId), eq(paranoidVaultRetired.version, version)),
        )
        .limit(1);
      return retired ?? null;
    },

    async compareAndSwap(input) {
      const {
        userId,
        expectedVersion,
        version,
        formatVersion,
        sizeBytes,
        blob,
        retention,
        now,
        retirementProofPublicKey = null,
      } = input;
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ privacyMode: users.privacyMode, mediaSet: users.paranoidMediaSet })
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
          if (current) return { status: 'precondition_failed', currentVersion: current.version };
          const inserted = await tx
            .insert(paranoidVaults)
            .values({
              userId,
              version,
              formatVersion,
              sizeBytes,
              blob,
              retirementProofPublicKey,
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

        if (!current || current.version !== expectedVersion) {
          return { status: 'precondition_failed', currentVersion: current?.version ?? null };
        }
        if (
          current.retirementProofPublicKey !== null &&
          retirementProofPublicKey !== null &&
          retirementProofPublicKey !== current.retirementProofPublicKey
        ) {
          return { status: 'proof_key_conflict' } as const;
        }

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
          .set({
            version,
            formatVersion,
            sizeBytes,
            blob,
            retirementProofPublicKey: current.retirementProofPublicKey ?? retirementProofPublicKey,
            updatedAt: now,
          })
          .where(eq(paranoidVaults.userId, userId))
          .returning();

        const cutoff = new Date(now.getTime() - retention.maxAgeMs);
        await tx
          .delete(paranoidVaultHistory)
          .where(
            and(
              eq(paranoidVaultHistory.userId, userId),
              lt(paranoidVaultHistory.createdAt, cutoff),
            ),
          );
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
        if (user.privacyMode !== 'paranoid') return { status: 'mode_required' } as const;
        const currentSelection = mediaSelectionOf(user);
        const [active] = await tx
          .select()
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, input.userId))
          .for('update');
        const [retirement] = await tx
          .select()
          .from(paranoidVaultRetirements)
          .where(eq(paranoidVaultRetirements.userId, input.userId))
          .for('update');
        const current = mediaStateOf(currentSelection, Boolean(active), null, retirement ?? null);
        if (!sameMediaSet(currentSelection.mediaSet, ['drive']) || active) {
          return { status: 'state_conflict', current } as const;
        }
        if (
          currentSelection.driveAttestedVersion !== null &&
          input.version < currentSelection.driveAttestedVersion
        ) {
          return { status: 'verification_failed', current } as const;
        }
        if (retirement && input.retirementProofPublicKey !== retirement.retirementProofPublicKey) {
          return { status: 'proof_key_conflict', current } as const;
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
        if (candidate && sameCandidate(candidate, input)) {
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
            retirementProofPublicKey: input.retirementProofPublicKey,
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

    async transitionMedia(input) {
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
        if (user.privacyMode !== 'paranoid') return { status: 'mode_required' } as const;

        const selection = mediaSelectionOf(user);
        const [active] = await tx
          .select()
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, input.userId))
          .for('update');
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
        let [retirement] = await tx
          .select()
          .from(paranoidVaultRetirements)
          .where(eq(paranoidVaultRetirements.userId, input.userId))
          .for('update');
        const currentState = mediaStateOf(
          selection,
          Boolean(active),
          candidate ?? null,
          retirement ?? null,
        );

        if (
          isIdempotentMediaTransition(
            input,
            selection,
            active,
            candidate ?? null,
            retirement ?? null,
          )
        ) {
          return { status: 'ok', state: currentState, idempotent: true } as const;
        }
        if (!sameMediaSelection(selection, input.expected)) {
          return { status: 'state_conflict', current: currentState } as const;
        }

        const transition = oneMediumTransition(selection.mediaSet, input.nextMediaSet);
        if (!transition) return { status: 'verification_failed', current: currentState } as const;

        let nextSelection: VaultMediaSelection;
        let nextActive = Boolean(active);
        let nextCandidate = candidate ?? null;
        let nextRetirement = retirement ?? null;

        if (transition.added === 'server') {
          if (
            input.verification.kind !== 'server-candidate' ||
            !input.candidateReadbackVerified ||
            active ||
            !candidate ||
            candidate.id !== input.verification.candidateId
          ) {
            return { status: 'verification_failed', current: currentState } as const;
          }
          if (
            selection.driveAttestedVersion !== null &&
            candidate.version < selection.driveAttestedVersion
          ) {
            return { status: 'verification_failed', current: currentState } as const;
          }
          if (
            retirement &&
            candidate.retirementProofPublicKey !== retirement.retirementProofPublicKey
          ) {
            return { status: 'proof_key_conflict', current: currentState } as const;
          }
          const [sameVersionRetired] = await tx
            .select()
            .from(paranoidVaultRetired)
            .where(
              and(
                eq(paranoidVaultRetired.userId, input.userId),
                eq(paranoidVaultRetired.version, candidate.version),
              ),
            )
            .for('update');
          if (sameVersionRetired && !sameBlob(sameVersionRetired, candidate)) {
            return { status: 'retirement_conflict', current: currentState } as const;
          }
          await tx.insert(paranoidVaults).values({
            userId: input.userId,
            version: candidate.version,
            formatVersion: candidate.formatVersion,
            sizeBytes: candidate.sizeBytes,
            blob: candidate.blob,
            retirementProofPublicKey: candidate.retirementProofPublicKey,
            createdAt: input.now,
            updatedAt: input.now,
          });
          await tx
            .delete(paranoidVaultServerCandidates)
            .where(eq(paranoidVaultServerCandidates.id, candidate.id));
          nextSelection = {
            mediaSet: canonicalMediaSet(input.nextMediaSet),
            driveAttestedVersion: candidate.version,
          };
          nextActive = true;
          nextCandidate = null;
        } else if (transition.added === 'drive') {
          if (
            input.verification.kind !== 'drive' ||
            !active ||
            input.verification.version < active.version
          ) {
            return { status: 'verification_failed', current: currentState } as const;
          }
          if (!active.retirementProofPublicKey) {
            return { status: 'proof_required', current: currentState } as const;
          }
          nextSelection = {
            mediaSet: canonicalMediaSet(input.nextMediaSet),
            driveAttestedVersion: input.verification.version,
          };
        } else if (transition.removed === 'drive') {
          if (
            input.verification.kind !== 'server' ||
            !active ||
            input.verification.version !== active.version
          ) {
            return { status: 'verification_failed', current: currentState } as const;
          }
          nextSelection = {
            mediaSet: canonicalMediaSet(input.nextMediaSet),
            driveAttestedVersion: null,
          };
        } else {
          // Removing server is intentionally non-destructive: every active and
          // bounded-history envelope is moved to the retirement set before the
          // active tables and durable media selection change.
          if (
            input.verification.kind !== 'drive' ||
            !active ||
            input.verification.version < active.version ||
            (selection.driveAttestedVersion !== null &&
              input.verification.version < selection.driveAttestedVersion)
          ) {
            return { status: 'verification_failed', current: currentState } as const;
          }
          if (!active.retirementProofPublicKey) {
            return { status: 'proof_required', current: currentState } as const;
          }
          if (
            retirement &&
            retirement.retirementProofPublicKey !== active.retirementProofPublicKey
          ) {
            return { status: 'proof_key_conflict', current: currentState } as const;
          }
          const history = await tx
            .select()
            .from(paranoidVaultHistory)
            .where(eq(paranoidVaultHistory.userId, input.userId))
            .for('update');
          const entries = [active, ...history];
          const retiredRows = await tx
            .select()
            .from(paranoidVaultRetired)
            .where(eq(paranoidVaultRetired.userId, input.userId))
            .for('update');
          const retiredByVersion = new Map(retiredRows.map((row) => [row.version, row]));
          if (
            entries.some((entry) => {
              const existing = retiredByVersion.get(entry.version);
              return existing !== undefined && !sameBlob(existing, entry);
            })
          ) {
            return { status: 'retirement_conflict', current: currentState } as const;
          }
          if (!retirement) {
            const [insertedRetirement] = await tx
              .insert(paranoidVaultRetirements)
              .values({
                userId: input.userId,
                retiredVersion: active.version,
                retirementProofPublicKey: active.retirementProofPublicKey,
                retiredAt: input.now,
              })
              .returning();
            retirement = insertedRetirement!;
          } else if (active.version > retirement.retiredVersion) {
            const [updatedRetirement] = await tx
              .update(paranoidVaultRetirements)
              .set({ retiredVersion: active.version, retiredAt: input.now })
              .where(eq(paranoidVaultRetirements.userId, input.userId))
              .returning();
            retirement = updatedRetirement!;
          } else if (active.version < retirement.retiredVersion) {
            return { status: 'retirement_conflict', current: currentState } as const;
          }
          for (const entry of entries) {
            if (retiredByVersion.has(entry.version)) continue;
            await tx.insert(paranoidVaultRetired).values({
              userId: input.userId,
              version: entry.version,
              formatVersion: entry.formatVersion,
              sizeBytes: entry.sizeBytes,
              blob: entry.blob,
              createdAt: entry.createdAt,
              retiredAt: input.now,
            });
          }
          await tx
            .delete(paranoidVaultHistory)
            .where(eq(paranoidVaultHistory.userId, input.userId));
          await tx.delete(paranoidVaults).where(eq(paranoidVaults.userId, input.userId));
          nextSelection = {
            mediaSet: canonicalMediaSet(input.nextMediaSet),
            driveAttestedVersion: input.verification.version,
          };
          nextActive = false;
          nextRetirement = retirement;
        }

        await tx
          .update(users)
          .set({
            paranoidMediaSet: nextSelection.mediaSet,
            paranoidDriveAttestedVersion: nextSelection.driveAttestedVersion,
            updatedAt: input.now,
          })
          .where(eq(users.id, input.userId));
        return {
          status: 'ok',
          state: mediaStateOf(nextSelection, nextActive, nextCandidate, nextRetirement),
          idempotent: false,
        } as const;
      });
    },

    async getRetirementState(userId) {
      const [row] = await db
        .select()
        .from(paranoidVaultRetirements)
        .where(eq(paranoidVaultRetirements.userId, userId));
      return row ?? null;
    },

    async purgeRetired(input) {
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
        if (user.privacyMode !== 'paranoid') return { status: 'mode_required' } as const;
        const selection = mediaSelectionOf(user);
        const [active] = await tx
          .select()
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, input.userId))
          .for('update');
        let [candidate] = await tx
          .select()
          .from(paranoidVaultServerCandidates)
          .where(eq(paranoidVaultServerCandidates.userId, input.userId))
          .for('update');
        // Candidate reads and transitions clean this up on access. Purge must
        // do the same under its lock: an expired staging row is no longer a
        // recoverable candidate and must not indefinitely block retirement
        // cleanup when no background sweeper has run.
        if (candidate && candidate.expiresAt.getTime() <= input.now.getTime()) {
          await tx
            .delete(paranoidVaultServerCandidates)
            .where(eq(paranoidVaultServerCandidates.id, candidate.id));
          candidate = undefined;
        }
        const [retirement] = await tx
          .select()
          .from(paranoidVaultRetirements)
          .where(eq(paranoidVaultRetirements.userId, input.userId))
          .for('update');
        const current = mediaStateOf(
          selection,
          Boolean(active),
          candidate ?? null,
          retirement ?? null,
        );
        if (!retirement) return { status: 'not_found' } as const;
        // A staged candidate is still server-held ciphertext. Do not report a
        // successful retirement purge unless this transaction leaves no server
        // bytes behind; preserving the candidate lets its owner either promote
        // it or let its normal expiry cleanup run first.
        if (selection.mediaSet.includes('server') || active || candidate) {
          return { status: 'state_conflict', current } as const;
        }
        if (retirement.retiredVersion !== input.retiredVersion) {
          return { status: 'state_conflict', current } as const;
        }
        if (!input.proofVerified) return { status: 'proof_required' } as const;
        const purgeAfter = new Date(
          retirement.retiredAt.getTime() + VAULT_RETIRED_SERVER_MIN_RETENTION_MS,
        );
        if (input.now.getTime() < purgeAfter.getTime()) {
          return { status: 'retention_pending', purgeAfter } as const;
        }
        await tx.delete(paranoidVaultRetired).where(eq(paranoidVaultRetired.userId, input.userId));
        await tx
          .delete(paranoidVaultRetirements)
          .where(eq(paranoidVaultRetirements.userId, input.userId));
        return { status: 'ok' } as const;
      });
    },
  };
}

function mediaSelectionOf(row: {
  mediaSet: string[] | null;
  driveAttestedVersion: number | null;
}): VaultMediaSelection {
  return {
    mediaSet: canonicalMediaSet(
      (row.mediaSet ?? []).filter((medium): medium is VaultMedium =>
        (['server', 'drive'] as const).includes(medium as VaultMedium),
      ),
    ),
    driveAttestedVersion: row.driveAttestedVersion,
  };
}

function mediaStateOf(
  selection: VaultMediaSelection,
  active: boolean,
  candidate: ParanoidVaultServerCandidateRow | null,
  retirement: ParanoidVaultRetirementRow | null,
): ParanoidVaultMediaState {
  const candidateMetadata = candidate
    ? {
        candidateId: candidate.id,
        version: candidate.version,
        formatVersion: candidate.formatVersion,
        sizeBytes: candidate.sizeBytes,
        expiresAt: candidate.expiresAt.toISOString(),
      }
    : null;
  const retiredMetadata = retirement
    ? {
        version: retirement.retiredVersion,
        retiredAt: retirement.retiredAt.toISOString(),
        purgeAfter: new Date(
          retirement.retiredAt.getTime() + VAULT_RETIRED_SERVER_MIN_RETENTION_MS,
        ).toISOString(),
      }
    : null;
  return {
    ...selection,
    server: {
      disposition: active
        ? 'active'
        : candidateMetadata
          ? 'inactive-candidate'
          : retiredMetadata
            ? 'retired'
            : 'empty',
      candidate: candidateMetadata,
      retired: retiredMetadata,
    },
  };
}

/**
 * A target-only match is not enough to acknowledge a retried media change:
 * another browser may have reached the same target first. Non-candidate edges
 * leave enough durable state to tie a retry to its read-back assertion. A
 * promoted candidate is deliberately deleted and its id never becomes active
 * vault metadata, so it cannot be safely identified after promotion. Such a
 * retry must reach the expected-state conflict below rather than report a
 * false successful promotion.
 */
function isIdempotentMediaTransition(
  input: ParanoidMediaTransitionInput,
  selection: VaultMediaSelection,
  active: ParanoidVaultRow | undefined,
  candidate: ParanoidVaultServerCandidateRow | null,
  retirement: ParanoidVaultRetirementRow | null,
): boolean {
  const transition = oneMediumTransition(input.expected.mediaSet, input.nextMediaSet);
  if (!transition || candidate) return false;

  switch (input.verification.kind) {
    case 'server-candidate':
      return false;
    case 'server':
      return (
        transition.removed === 'drive' &&
        active?.version === input.verification.version &&
        sameMediaSelection(selection, {
          mediaSet: canonicalMediaSet(input.nextMediaSet),
          driveAttestedVersion: null,
        })
      );
    case 'drive':
      if (transition.added === 'drive') {
        return (
          active !== undefined &&
          active.version <= input.verification.version &&
          sameMediaSelection(selection, {
            mediaSet: canonicalMediaSet(input.nextMediaSet),
            driveAttestedVersion: input.verification.version,
          })
        );
      }
      return (
        transition.removed === 'server' &&
        active === undefined &&
        retirement !== null &&
        retirement.retiredVersion <= input.verification.version &&
        sameMediaSelection(selection, {
          mediaSet: canonicalMediaSet(input.nextMediaSet),
          driveAttestedVersion: input.verification.version,
        })
      );
  }
}

function canonicalMediaSet(mediaSet: readonly VaultMedium[]): VaultMediaSet {
  return (['server', 'drive'] as const).filter((medium) => mediaSet.includes(medium));
}

function sameMediaSet(left: readonly VaultMedium[], right: readonly VaultMedium[]): boolean {
  return left.length === right.length && left.every((medium) => right.includes(medium));
}

function sameMediaSelection(left: VaultMediaSelection, right: VaultMediaSelection): boolean {
  return (
    sameMediaSet(left.mediaSet, right.mediaSet) &&
    left.driveAttestedVersion === right.driveAttestedVersion
  );
}

function oneMediumTransition(
  from: readonly VaultMedium[],
  to: readonly VaultMedium[],
): { added?: VaultMedium; removed?: VaultMedium } | null {
  const added = to.filter((medium) => !from.includes(medium));
  const removed = from.filter((medium) => !to.includes(medium));
  return added.length + removed.length === 1 ? { added: added[0], removed: removed[0] } : null;
}

function sameBlob(
  left: Pick<ParanoidVaultBlobInput, 'version' | 'formatVersion' | 'sizeBytes' | 'blob'>,
  right: Pick<ParanoidVaultBlobInput, 'version' | 'formatVersion' | 'sizeBytes' | 'blob'>,
): boolean {
  return (
    left.version === right.version &&
    left.formatVersion === right.formatVersion &&
    left.sizeBytes === right.sizeBytes &&
    left.blob.equals(right.blob)
  );
}

function sameCandidate(
  left: ParanoidVaultServerCandidateRow,
  right: ParanoidStageServerCandidateInput,
): boolean {
  return sameBlob(left, right) && left.retirementProofPublicKey === right.retirementProofPublicKey;
}
