import { createHash } from 'node:crypto';

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';

import {
  readVaultDocServerHeader,
  serializeVaultRetirementVersionSet,
  VAULT_HISTORY_PAGE_DEFAULT,
  VAULT_HISTORY_PAGE_MAX,
  VAULT_RETIRED_SERVER_MIN_RETENTION_MS,
  type PerVaultMediaDocAttestation,
  type PerVaultMediaState,
  type PerVaultMediaTransitionRequest,
  type PerVaultServerCandidateMetadata,
  type VaultDocKind,
  type VaultDocServerHeader,
  type VaultVersionSetHash,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  driveConnections,
  portfolioVaultTransitionStates,
  portfolios,
  vaultBlobHistory,
  vaultBlobs,
  vaultRetired,
  vaultRetirements,
  vaultServerCandidates,
  vaults,
  type VaultBlobHistoryRow,
  type VaultBlobRow,
  type VaultRetiredRow,
  type VaultRow,
  type VaultServerCandidateRow,
} from '../schema';

export interface VaultBlobRetention {
  maxVersions: number;
  maxAgeMs: number;
}

export type VaultBlobReadResult =
  | { status: 'ok'; row: VaultBlobRow }
  | { status: 'not_found' }
  | { status: 'medium_inactive' };

export type VaultBlobWriteResult =
  | { status: 'ok'; row: VaultBlobRow; idempotent: boolean }
  | { status: 'not_found' }
  | { status: 'portfolio_binding_mismatch' }
  | { status: 'doc_kind_mismatch' }
  | { status: 'precondition_failed'; currentVersion: number | null }
  | { status: 'medium_inactive' };

export type VaultBlobHistoryResult<T> = { status: 'ok'; value: T } | { status: 'not_found' };

export type VaultCandidateResult =
  | { status: 'ok'; row: VaultServerCandidateRow; idempotent: boolean }
  | { status: 'not_found' }
  | { status: 'portfolio_binding_mismatch' }
  | { status: 'doc_kind_mismatch' }
  | { status: 'state_conflict' };

export type VaultMediaTransitionResult =
  | { status: 'ok'; state: PerVaultMediaState; idempotent: boolean }
  | { status: 'not_found' }
  | { status: 'reserved_medium' }
  | { status: 'state_conflict'; current: PerVaultMediaState }
  | { status: 'retirement_pending'; current: PerVaultMediaState }
  | { status: 'partial_set'; current: PerVaultMediaState }
  | { status: 'verification_failed'; current: PerVaultMediaState }
  | { status: 'drive_not_found'; current: PerVaultMediaState }
  | { status: 'retirement_conflict'; current: PerVaultMediaState };

export interface VaultRetirementState {
  vaultId: string;
  generation: number;
  versionSetHash: VaultVersionSetHash;
  retirementProofPublicKey: string;
  retiredAt: Date;
  purgeAfter: Date;
}

export type VaultRetiredPurgeResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'state_conflict' }
  | { status: 'partial_set' }
  | { status: 'retention_pending'; purgeAfter: Date };

export interface VaultBlobRepository {
  readCurrent(userId: string, vaultId: string, docId: string): Promise<VaultBlobReadResult>;
  compareAndSwap(input: {
    userId: string;
    vaultId: string;
    docId: string;
    header: VaultDocServerHeader;
    expectedVersion: number | null;
    blob: Buffer;
    retention: VaultBlobRetention;
    now: Date;
  }): Promise<VaultBlobWriteResult>;
  listHistory(input: {
    userId: string;
    vaultId: string;
    docId: string;
    cursor?: number;
    limit?: number;
  }): Promise<
    VaultBlobHistoryResult<{
      items: Array<{ version: number; sizeBytes: number; createdAt: Date }>;
      nextCursor: number | null;
    }>
  >;
  getHistory(
    userId: string,
    vaultId: string,
    docId: string,
    version: number,
  ): Promise<VaultBlobHistoryResult<VaultBlobHistoryRow | VaultRetiredRow>>;
  getMediaState(userId: string, vaultId: string, now: Date): Promise<PerVaultMediaState | null>;
  stageServerCandidate(input: {
    userId: string;
    vaultId: string;
    transitionId: string;
    docId: string;
    header: VaultDocServerHeader;
    blob: Buffer;
    now: Date;
    expiresAt: Date;
  }): Promise<VaultCandidateResult>;
  getServerCandidate(
    userId: string,
    vaultId: string,
    candidateId: string,
    now: Date,
  ): Promise<VaultServerCandidateRow | null>;
  /**
   * Bounded sweep of staged candidates past their TTL, independent of whether
   * their vault is ever read again (#1521, closing the gap in the #1491
   * retention ruling). Returns the number of rows disposed; a short return
   * proves the cutoff is drained.
   */
  cleanupExpiredServerCandidates(expiresAtOrBefore: Date, limit: number): Promise<number>;
  transitionMedia(input: {
    userId: string;
    vaultId: string;
    request: PerVaultMediaTransitionRequest;
    verifiedCandidateIds: ReadonlySet<string>;
    now: Date;
  }): Promise<VaultMediaTransitionResult>;
  getRetirementState(userId: string, vaultId: string): Promise<VaultRetirementState | null>;
  purgeRetired(input: {
    userId: string;
    vaultId: string;
    generation: number;
    versionSetHash: string;
    observedDocs: PerVaultMediaDocAttestation[];
    proofVerified: true;
    now: Date;
  }): Promise<VaultRetiredPurgeResult>;
}

interface ExpectedDoc {
  docId: string;
  docKind: VaultDocKind;
  portfolioId: string | null;
  /**
   * Present only while the caller holds this prospective portfolio's
   * transition row lock. The binding is persisted immediately before the
   * admitted write, so a refused CAS never consumes a capture target.
   */
  bindProspectiveCapture?: true;
}

type ExpectedDocVault = Pick<
  VaultRow,
  | 'id'
  | 'userId'
  | 'headerDocId'
  | 'commonDocId'
  | 'media'
  | 'driveConnectionId'
  | 'mediaAttestedAt'
  | 'mediaAttestedDriveConnectionId'
>;

interface ExpectedDocOptions {
  now: Date;
  lockAndPrepareProspective?: boolean;
}

/**
 * A nullable transition id exists only for candidates written before R3. Such
 * a row has no batch identity and therefore cannot safely participate in an
 * E1 readback or transition. The service maps this domain refusal to a stable
 * 409 instead of exposing an invariant Error as a 500.
 */
export class LegacyVaultCandidateError extends Error {
  constructor() {
    super('A legacy server candidate has no transition id and must be re-staged.');
    this.name = 'LegacyVaultCandidateError';
  }
}

function mediaEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((medium) => right.includes(medium));
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function foreignKeyConstraint(error: unknown): string {
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
  };
  if (candidate?.code !== '23503') return '';
  const named =
    (typeof candidate.constraint === 'string' && candidate.constraint) ||
    (typeof candidate.constraint_name === 'string' && candidate.constraint_name) ||
    '';
  if (named) return named;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (!message) return '';
  return (
    [
      'vault_blobs_portfolio_id_portfolios_id_fk',
      'vaults_drive_connection_id_drive_connections_id_fk',
      'vaults_media_attested_drive_connection_fk',
    ].find((constraint) => message.includes(constraint)) ?? ''
  );
}

function headerOf(row: { blob: Buffer }): VaultDocServerHeader {
  // R2 is the complete server-readable projection. Parsing any payload byte or
  // inspecting any additional header property here is a blind-store design
  // violation.
  return readVaultDocServerHeader(row.blob);
}

function candidateMetadata(row: VaultServerCandidateRow): PerVaultServerCandidateMetadata {
  const header = headerOf(row);
  if (!row.transitionId) throw new LegacyVaultCandidateError();
  return {
    candidateId: row.id,
    transitionId: row.transitionId,
    docId: row.docId,
    docKind: header.docKind,
    docVersion: row.version,
    formatVersion: row.formatVersion,
    writeId: header.writeId,
    sizeBytes: row.sizeBytes,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function versionSetHash(rows: readonly { docId: string; version: number }[]): VaultVersionSetHash {
  return createHash('sha256')
    .update(
      serializeVaultRetirementVersionSet(
        rows.map((row) => ({ docId: row.docId, docVersion: row.version })),
      ),
    )
    .digest('base64url');
}

function attestationsOf(
  rows: readonly { docId: string; version: number; blob: Buffer }[],
): PerVaultMediaDocAttestation[] {
  return [...rows]
    .sort((left, right) => (left.docId < right.docId ? -1 : left.docId > right.docId ? 1 : 0))
    .map((row) => {
      const header = headerOf(row);
      return { docId: row.docId, docVersion: row.version, writeId: header.writeId };
    });
}

function attestationsEqual(
  supplied: readonly PerVaultMediaDocAttestation[],
  rows: readonly { docId: string; version: number; blob: Buffer }[],
): boolean {
  const actual = attestationsOf(rows);
  if (actual.length !== supplied.length) return false;
  const byDoc = new Map(supplied.map((doc) => [doc.docId, doc]));
  return actual.every((doc) => {
    const candidate = byDoc.get(doc.docId);
    return candidate?.docVersion === doc.docVersion && candidate.writeId === doc.writeId;
  });
}

function attestationRosterEqual(
  supplied: readonly PerVaultMediaDocAttestation[],
  roster: readonly ExpectedDoc[],
): boolean {
  if (supplied.length !== roster.length) return false;
  const suppliedIds = new Set(supplied.map((doc) => doc.docId));
  return roster.every((doc) => suppliedIds.has(doc.docId));
}

function historyPageSize(requested: number | undefined): number {
  if (!Number.isSafeInteger(requested) || !requested || requested < 1) {
    return VAULT_HISTORY_PAGE_DEFAULT;
  }
  return Math.min(requested, VAULT_HISTORY_PAGE_MAX);
}

async function expectedDocs(
  executor: Database,
  vault: ExpectedDocVault,
  now: Date,
): Promise<ExpectedDoc[]> {
  const [members, prospectiveCaptures] = await Promise.all([
    executor
      .select({ id: portfolios.id })
      .from(portfolios)
      .leftJoin(
        portfolioVaultTransitionStates,
        eq(portfolioVaultTransitionStates.portfolioId, portfolios.id),
      )
      .where(
        and(
          eq(portfolios.userId, vault.userId),
          eq(portfolios.vaultId, vault.id),
          or(
            isNull(portfolioVaultTransitionStates.moveOutPostCommitPending),
            eq(portfolioVaultTransitionStates.moveOutPostCommitPending, false),
          ),
        ),
      )
      .orderBy(asc(portfolios.id)),
    executor
      .select({
        id: portfolios.id,
        captureRevision: portfolioVaultTransitionStates.captureRevision,
        captureExpiresAt: portfolioVaultTransitionStates.captureExpiresAt,
        captureMediaAttestedAt: portfolioVaultTransitionStates.captureMediaAttestedAt,
      })
      .from(portfolios)
      .innerJoin(
        portfolioVaultTransitionStates,
        eq(portfolioVaultTransitionStates.portfolioId, portfolios.id),
      )
      .where(
        and(
          eq(portfolios.userId, vault.userId),
          isNull(portfolios.vaultId),
          eq(portfolioVaultTransitionStates.userId, vault.userId),
          eq(portfolioVaultTransitionStates.captureVaultId, vault.id),
        ),
      )
      .orderBy(asc(portfolios.id)),
  ]);
  const portfolioIds = [
    ...members.map(({ id }) => id),
    ...prospectiveCaptures
      .filter(
        ({ captureRevision, captureExpiresAt, captureMediaAttestedAt }) =>
          captureRevision !== null &&
          captureExpiresAt !== null &&
          captureExpiresAt.getTime() > now.getTime() &&
          captureMediaAttestedAt !== null,
      )
      .map(({ id }) => id),
  ].sort();
  return [
    { docId: vault.headerDocId, docKind: 'header', portfolioId: null },
    { docId: vault.commonDocId, docKind: 'common', portfolioId: null },
    ...portfolioIds.map((id) => ({
      // R1: the portfolio document address is the locked stub id itself.
      docId: id,
      docKind: 'portfolio' as const,
      portfolioId: id,
    })),
  ];
}

async function expectedDoc(
  executor: Database,
  vault: ExpectedDocVault,
  docId: string,
  options: ExpectedDocOptions,
): Promise<ExpectedDoc | null> {
  if (docId === vault.headerDocId) return { docId, docKind: 'header', portfolioId: null };
  if (docId === vault.commonDocId) return { docId, docKind: 'common', portfolioId: null };
  const [portfolio] = await executor
    .select({
      id: portfolios.id,
      vaultId: portfolios.vaultId,
      moveOutPostCommitPending: portfolioVaultTransitionStates.moveOutPostCommitPending,
    })
    .from(portfolios)
    .leftJoin(
      portfolioVaultTransitionStates,
      eq(portfolioVaultTransitionStates.portfolioId, portfolios.id),
    )
    .where(and(eq(portfolios.id, docId), eq(portfolios.userId, vault.userId)))
    .limit(1);
  if (!portfolio) return null;
  // The restore graph has committed, E2 admission is open, and the encrypted
  // portfolio document was archived. Keep that document excluded from direct
  // CAS/read admission and media rosters while the durable retry marker exists,
  // so a sync cannot resurrect ciphertext during derived-state convergence.
  if (portfolio.moveOutPostCommitPending) return null;
  if (portfolio.vaultId === vault.id) {
    return { docId, docKind: 'portfolio', portfolioId: docId };
  }
  // A portfolio assigned to another vault is never prospective. A normal
  // portfolio gets this narrow E4 staging exception only through its own live
  // capture row.
  if (portfolio.vaultId !== null) return null;

  const transitionQuery = executor
    .select({
      captureRevision: portfolioVaultTransitionStates.captureRevision,
      captureExpiresAt: portfolioVaultTransitionStates.captureExpiresAt,
      captureVaultId: portfolioVaultTransitionStates.captureVaultId,
      captureMediaAttestedAt: portfolioVaultTransitionStates.captureMediaAttestedAt,
    })
    .from(portfolioVaultTransitionStates)
    .where(
      and(
        eq(portfolioVaultTransitionStates.portfolioId, docId),
        eq(portfolioVaultTransitionStates.userId, vault.userId),
      ),
    )
    .limit(1);
  const [capture] = options.lockAndPrepareProspective
    ? await transitionQuery.for('update')
    : await transitionQuery;
  if (
    !capture ||
    capture.captureRevision === null ||
    capture.captureExpiresAt === null ||
    capture.captureExpiresAt.getTime() <= options.now.getTime()
  ) {
    return null;
  }
  if (capture.captureVaultId === vault.id) {
    return capture.captureMediaAttestedAt !== null
      ? { docId, docKind: 'portfolio', portfolioId: docId }
      : null;
  }
  if (capture.captureVaultId !== null || !options.lockAndPrepareProspective) return null;

  const expectedDriveConnectionId = vault.media.includes('drive') ? vault.driveConnectionId : null;
  const vaultHasCurrentAttestation =
    vault.mediaAttestedAt !== null &&
    (!vault.media.includes('drive') || vault.driveConnectionId !== null) &&
    vault.mediaAttestedDriveConnectionId === expectedDriveConnectionId;
  return vaultHasCurrentAttestation
    ? {
        docId,
        docKind: 'portfolio',
        portfolioId: docId,
        bindProspectiveCapture: true,
      }
    : null;
}

async function bindProspectiveCapture(
  executor: Database,
  vault: ExpectedDocVault,
  doc: ExpectedDoc,
  now: Date,
): Promise<void> {
  if (!doc.bindProspectiveCapture) return;
  if (!doc.portfolioId || !vault.mediaAttestedAt) {
    throw new Error('prospective portfolio capture lost its verified admission facts');
  }
  const [bound] = await executor
    .update(portfolioVaultTransitionStates)
    .set({
      captureVaultId: vault.id,
      captureMediaAttestedAt: vault.mediaAttestedAt,
      captureMediaAttestedDriveConnectionId: vault.mediaAttestedDriveConnectionId,
      updatedAt: now,
    })
    .where(
      and(
        eq(portfolioVaultTransitionStates.portfolioId, doc.portfolioId),
        eq(portfolioVaultTransitionStates.userId, vault.userId),
        isNull(portfolioVaultTransitionStates.captureVaultId),
      ),
    )
    .returning({ portfolioId: portfolioVaultTransitionStates.portfolioId });
  // The row is locked from admission until this update. Missing it means an
  // invariant was broken inside this transaction, so abort all candidate/blob
  // mutations instead of committing a write without its capture binding.
  if (!bound) throw new Error('prospective portfolio capture binding disappeared');

  // The capture row now owns the old full-set proof. Invalidate the live vault
  // proof in the same transaction as the first prospective document admission,
  // regardless of whether its bytes are going to the active server store or a
  // Drive-only candidate set. Subsequent documents remain admissible through
  // the locked capture binding and the client must attest the completed roster
  // before the destructive move-in commit can proceed.
  await executor
    .update(vaults)
    .set({
      mediaAttestedAt: null,
      mediaAttestedDriveConnectionId: null,
      updatedAt: now,
    })
    .where(eq(vaults.id, vault.id));
}

async function ownerHasPortfolio(
  executor: Database,
  userId: string,
  portfolioId: string,
): Promise<boolean> {
  const [portfolio] = await executor
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1);
  return portfolio !== undefined;
}

async function hasLiveBoundProspectiveCapture(
  executor: Database,
  vault: ExpectedDocVault,
  now: Date,
): Promise<boolean> {
  const [capture] = await executor
    .select({ portfolioId: portfolioVaultTransitionStates.portfolioId })
    .from(portfolioVaultTransitionStates)
    .where(
      and(
        eq(portfolioVaultTransitionStates.userId, vault.userId),
        eq(portfolioVaultTransitionStates.captureVaultId, vault.id),
        isNotNull(portfolioVaultTransitionStates.captureRevision),
        gt(portfolioVaultTransitionStates.captureExpiresAt, now),
        isNotNull(portfolioVaultTransitionStates.captureMediaAttestedAt),
      ),
    )
    .limit(1);
  return capture !== undefined;
}

function exactRoster(expected: readonly ExpectedDoc[], rows: readonly VaultBlobRow[]): boolean {
  if (expected.length !== rows.length) return false;
  const roster = new Map(expected.map((doc) => [doc.docId, doc]));
  return rows.every((row) => {
    const doc = roster.get(row.docId);
    return doc?.docKind === row.docKind && doc.portfolioId === row.portfolioId;
  });
}

function exactCandidateRoster(
  expected: readonly ExpectedDoc[],
  rows: readonly VaultServerCandidateRow[],
  input: { vaultId: string; transitionId: string; now: Date },
): boolean {
  if (expected.length !== rows.length) return false;
  const roster = new Map(expected.map((doc) => [doc.docId, doc]));
  return rows.every((row) => {
    const doc = roster.get(row.docId);
    const header = headerOf(row);
    return (
      row.transitionId === input.transitionId &&
      row.expiresAt.getTime() > input.now.getTime() &&
      doc?.docKind === header.docKind &&
      header.vaultId === input.vaultId &&
      header.docId === row.docId &&
      header.docVersion === row.version
    );
  });
}

/**
 * The single disposal path for staged candidates. Every removal of an EXPIRED
 * row — the lazy checks below and the periodic sweeper that makes the #1491
 * retention TTL real for a vault nobody reads again — routes through here, so
 * there is exactly one implementation of "this candidate is gone".
 */
async function disposeCandidates(executor: Database, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const disposed = await executor
    .delete(vaultServerCandidates)
    .where(inArray(vaultServerCandidates.id, [...ids]))
    .returning({ id: vaultServerCandidates.id });
  return disposed.length;
}

async function mediaState(
  executor: Database,
  vault: VaultRow,
  now: Date,
  cleanExpired: boolean,
): Promise<PerVaultMediaState> {
  let candidates = await executor
    .select()
    .from(vaultServerCandidates)
    .where(eq(vaultServerCandidates.vaultId, vault.id))
    .orderBy(asc(vaultServerCandidates.docId));
  const expiredIds = candidates
    .filter((candidate) => candidate.expiresAt.getTime() <= now.getTime())
    .map((candidate) => candidate.id);
  if (cleanExpired && expiredIds.length > 0) {
    await disposeCandidates(executor, expiredIds);
    candidates = candidates.filter((candidate) => !expiredIds.includes(candidate.id));
  }
  const [retirement] = await executor
    .select()
    .from(vaultRetirements)
    .where(eq(vaultRetirements.vaultId, vault.id))
    .limit(1);
  const retiredRows = retirement
    ? await executor
        .select({ docId: vaultRetired.docId, version: vaultRetired.version })
        .from(vaultRetired)
        .where(eq(vaultRetired.vaultId, vault.id))
    : [];
  const active = vault.media.includes('server');
  return {
    vaultId: vault.id,
    media: vault.media as PerVaultMediaState['media'],
    driveConnectionId: vault.driveConnectionId,
    mediaAttestedAt: vault.mediaAttestedAt?.toISOString() ?? null,
    mediaAttestedDriveConnectionId: vault.mediaAttestedDriveConnectionId,
    server: {
      disposition: active
        ? 'active'
        : candidates.length > 0
          ? 'inactive-candidates'
          : retirement
            ? 'retired'
            : 'empty',
      candidates: candidates.map(candidateMetadata),
      retirement: retirement
        ? {
            generation: retirement.generation,
            versionSetHash: versionSetHash(retiredRows),
            retiredAt: retirement.retiredAt.toISOString(),
            purgeAfter: new Date(
              retirement.retiredAt.getTime() + VAULT_RETIRED_SERVER_MIN_RETENTION_MS,
            ).toISOString(),
          }
        : null,
    },
  };
}

export function createVaultBlobRepository(db: Database): VaultBlobRepository {
  const findOwnedVault = async (userId: string, vaultId: string): Promise<VaultRow | null> => {
    const [vault] = await db
      .select()
      .from(vaults)
      .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)))
      .limit(1);
    return vault ?? null;
  };

  return {
    async readCurrent(userId, vaultId, docId) {
      const vault = await findOwnedVault(userId, vaultId);
      if (!vault) return { status: 'not_found' };
      if (!(await expectedDoc(db, vault, docId, { now: new Date() }))) {
        return { status: 'not_found' };
      }
      if (!vault.media.includes('server')) return { status: 'medium_inactive' };
      const [row] = await db
        .select()
        .from(vaultBlobs)
        .where(and(eq(vaultBlobs.vaultId, vaultId), eq(vaultBlobs.docId, docId)))
        .limit(1);
      return row ? { status: 'ok', row } : { status: 'not_found' };
    },

    async compareAndSwap(input) {
      try {
        return await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Database;
          const [vault] = await tx
            .select()
            .from(vaults)
            .where(and(eq(vaults.id, input.vaultId), eq(vaults.userId, input.userId)))
            .for('update');
          if (!vault) return { status: 'not_found' as const };
          const doc = await expectedDoc(tx, vault, input.docId, {
            now: input.now,
            lockAndPrepareProspective:
              input.header.docKind === 'portfolio' && vault.media.includes('server'),
          });
          if (!doc) {
            // Do not turn a foreign portfolio UUID into an ownership oracle.
            // R1's explicit binding refusal is reserved for a portfolio the
            // caller owns but which is not a locked member of this vault.
            return input.header.docKind === 'portfolio' &&
              (await ownerHasPortfolio(tx, input.userId, input.docId))
              ? ({ status: 'portfolio_binding_mismatch' } as const)
              : ({ status: 'not_found' } as const);
          }
          if (doc.docKind !== input.header.docKind) return { status: 'doc_kind_mismatch' } as const;
          if (!vault.media.includes('server')) return { status: 'medium_inactive' } as const;

          const [current] = await tx
            .select()
            .from(vaultBlobs)
            .where(and(eq(vaultBlobs.vaultId, input.vaultId), eq(vaultBlobs.docId, input.docId)))
            .for('update');

          // Idempotency key: (vaultId, docId, writeId). A byte-identical replay
          // of the committed docVersion is a no-op and creates no history row.
          if (current) {
            const currentHeader = headerOf(current);
            if (currentHeader.writeId === input.header.writeId) {
              if (
                current.version === input.header.docVersion &&
                sameBytes(current.blob, input.blob)
              ) {
                await bindProspectiveCapture(tx, vault, doc, input.now);
                return { status: 'ok', row: current, idempotent: true } as const;
              }
              return {
                status: 'precondition_failed',
                currentVersion: current.version,
              } as const;
            }
          }

          // A retry can arrive after another writer has advanced the doc (or,
          // because R2 makes docVersion client-owned, after the ETag has cycled
          // back to the retry's old If-Match value). Search the bounded retained
          // rows by the same lifetime idempotency key before applying CAS. This
          // reads only R2's six-field projection; no ciphertext is interpreted.
          // After a receipt ages out of bounded history (or its retired set is
          // signed-purged), normal CAS applies; R1-R5 authorize no unbounded
          // server-side write-receipt store, and clients mint globally unique ids.
          const [historyReceipts, retiredReceipts] = await Promise.all([
            tx
              .select()
              .from(vaultBlobHistory)
              .where(
                and(
                  eq(vaultBlobHistory.vaultId, input.vaultId),
                  eq(vaultBlobHistory.docId, input.docId),
                ),
              )
              .for('update'),
            tx
              .select()
              .from(vaultRetired)
              .where(
                and(eq(vaultRetired.vaultId, input.vaultId), eq(vaultRetired.docId, input.docId)),
              )
              .for('update'),
          ]);
          const retainedReplay = [...historyReceipts, ...retiredReceipts].find(
            (row) => headerOf(row).writeId === input.header.writeId,
          );
          if (retainedReplay) {
            if (
              current &&
              retainedReplay.version === input.header.docVersion &&
              sameBytes(retainedReplay.blob, input.blob)
            ) {
              await bindProspectiveCapture(tx, vault, doc, input.now);
              return { status: 'ok', row: current, idempotent: true } as const;
            }
            return {
              status: 'precondition_failed',
              currentVersion: current?.version ?? null,
            } as const;
          }

          // docVersion is non-monotonic client merge state, but it is still an
          // immutable byte-string identity within one document. Reusing a
          // token for different envelope bytes would make current/history (or
          // a later retired set) attest two incompatible facts for the same
          // (docId, docVersion) pair. Distinct lower/higher tokens remain fully
          // legal; only an exact token collision is refused.
          const versionReceipt = [current, ...historyReceipts, ...retiredReceipts].find(
            (row) => row?.version === input.header.docVersion,
          );
          if (versionReceipt && !sameBytes(versionReceipt.blob, input.blob)) {
            return {
              status: 'precondition_failed',
              currentVersion: current?.version ?? null,
            } as const;
          }

          const currentVersion = current?.version ?? null;
          // The HTTP precondition is the entire server-side CAS decision.
          // `docVersion` is client-owned merge state (and can move non-linearly
          // after a client merge); the blind store records it but never gates it.
          if (currentVersion !== input.expectedVersion) {
            return { status: 'precondition_failed', currentVersion } as const;
          }

          await bindProspectiveCapture(tx, vault, doc, input.now);

          if (current) {
            await tx
              .insert(vaultBlobHistory)
              .values({
                vaultId: current.vaultId,
                docId: current.docId,
                version: current.version,
                formatVersion: current.formatVersion,
                sizeBytes: current.sizeBytes,
                blob: current.blob,
                // History age begins when the version is superseded, not when the
                // once-current bytes were first written.
                createdAt: input.now,
              })
              // A client that reuses an old docVersion has violated its merge
              // protocol, but that is still not a server version gate. Preserve
              // the first safety-net row for that token, matching v1 behavior.
              .onConflictDoNothing();
          }

          const values = {
            vaultId: input.vaultId,
            docId: input.docId,
            docKind: doc.docKind,
            portfolioId: doc.portfolioId,
            version: input.header.docVersion,
            formatVersion: input.header.formatVersion,
            sizeBytes: input.blob.length,
            blob: input.blob,
            updatedAt: input.now,
          };
          const [stored] = current
            ? await tx
                .update(vaultBlobs)
                .set(values)
                .where(
                  and(eq(vaultBlobs.vaultId, input.vaultId), eq(vaultBlobs.docId, input.docId)),
                )
                .returning()
            : await tx
                .insert(vaultBlobs)
                .values({ ...values, createdAt: input.now })
                .returning();
          if (!stored) throw new Error('vault blob write returned no row');

          // Any live write makes the last full-set media proof stale.
          await tx
            .update(vaults)
            .set({
              mediaAttestedAt: null,
              mediaAttestedDriveConnectionId: null,
              updatedAt: input.now,
            })
            .where(eq(vaults.id, input.vaultId));

          const cutoff = new Date(input.now.getTime() - input.retention.maxAgeMs);
          await tx
            .delete(vaultBlobHistory)
            .where(
              and(
                eq(vaultBlobHistory.vaultId, input.vaultId),
                eq(vaultBlobHistory.docId, input.docId),
                lt(vaultBlobHistory.createdAt, cutoff),
              ),
            );
          const excess = await tx
            .select({ id: vaultBlobHistory.id })
            .from(vaultBlobHistory)
            .where(
              and(
                eq(vaultBlobHistory.vaultId, input.vaultId),
                eq(vaultBlobHistory.docId, input.docId),
              ),
            )
            // Bounded history means the last N superseded writes. docVersion
            // can move non-linearly under R2, so numeric ordering would retain
            // an older high token and discard a newer low token.
            .orderBy(desc(vaultBlobHistory.createdAt), desc(vaultBlobHistory.id))
            .offset(Math.max(0, input.retention.maxVersions));
          if (excess.length > 0) {
            await tx.delete(vaultBlobHistory).where(
              inArray(
                vaultBlobHistory.id,
                excess.map(({ id }) => id),
              ),
            );
          }
          return { status: 'ok', row: stored, idempotent: false } as const;
        });
      } catch (error) {
        // This FK is deferred so a concurrent move-out can surface only when
        // the transaction commits. Treat the lost locked-stub binding exactly
        // like the owner-scoped pre-insert check, never as a 500.
        if (foreignKeyConstraint(error) === 'vault_blobs_portfolio_id_portfolios_id_fk') {
          return { status: 'portfolio_binding_mismatch' };
        }
        throw error;
      }
    },

    async listHistory(input) {
      const vault = await findOwnedVault(input.userId, input.vaultId);
      if (!vault || !(await expectedDoc(db, vault, input.docId, { now: new Date() }))) {
        return { status: 'not_found' };
      }
      const [history, retired] = await Promise.all([
        db
          .select({
            version: vaultBlobHistory.version,
            sizeBytes: vaultBlobHistory.sizeBytes,
            createdAt: vaultBlobHistory.createdAt,
          })
          .from(vaultBlobHistory)
          .where(
            and(
              eq(vaultBlobHistory.vaultId, input.vaultId),
              eq(vaultBlobHistory.docId, input.docId),
            ),
          ),
        db
          .select({
            version: vaultRetired.version,
            sizeBytes: vaultRetired.sizeBytes,
            createdAt: vaultRetired.createdAt,
          })
          .from(vaultRetired)
          .where(and(eq(vaultRetired.vaultId, input.vaultId), eq(vaultRetired.docId, input.docId))),
      ]);
      const byVersion = new Map([...retired, ...history].map((row) => [row.version, row]));
      const all = [...byVersion.values()]
        .filter((row) => input.cursor === undefined || row.version < input.cursor)
        .sort((left, right) => right.version - left.version);
      const limit = historyPageSize(input.limit);
      const items = all.slice(0, limit);
      return {
        status: 'ok',
        value: {
          items,
          nextCursor: all.length > limit ? items.at(-1)!.version : null,
        },
      };
    },

    async getHistory(userId, vaultId, docId, version) {
      const vault = await findOwnedVault(userId, vaultId);
      if (!vault || !(await expectedDoc(db, vault, docId, { now: new Date() }))) {
        return { status: 'not_found' };
      }
      const [history] = await db
        .select()
        .from(vaultBlobHistory)
        .where(
          and(
            eq(vaultBlobHistory.vaultId, vaultId),
            eq(vaultBlobHistory.docId, docId),
            eq(vaultBlobHistory.version, version),
          ),
        )
        .limit(1);
      if (history) return { status: 'ok', value: history };
      const [retired] = await db
        .select()
        .from(vaultRetired)
        .where(
          and(
            eq(vaultRetired.vaultId, vaultId),
            eq(vaultRetired.docId, docId),
            eq(vaultRetired.version, version),
          ),
        )
        .limit(1);
      return retired ? { status: 'ok', value: retired } : { status: 'not_found' };
    },

    async getMediaState(userId, vaultId, now) {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const [vault] = await tx
          .select()
          .from(vaults)
          .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)))
          .for('update');
        return vault ? mediaState(tx, vault, now, true) : null;
      });
    },

    async stageServerCandidate(input) {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const [vault] = await tx
          .select()
          .from(vaults)
          .where(and(eq(vaults.id, input.vaultId), eq(vaults.userId, input.userId)))
          .for('update');
        if (!vault) return { status: 'not_found' as const };
        if (!mediaEqual(vault.media, ['drive'])) return { status: 'state_conflict' as const };
        const doc = await expectedDoc(tx, vault, input.docId, {
          now: input.now,
          lockAndPrepareProspective: input.header.docKind === 'portfolio',
        });
        if (!doc) {
          return input.header.docKind === 'portfolio' &&
            (await ownerHasPortfolio(tx, input.userId, input.docId))
            ? ({ status: 'portfolio_binding_mismatch' } as const)
            : ({ status: 'not_found' } as const);
        }
        if (doc.docKind !== input.header.docKind) return { status: 'doc_kind_mismatch' } as const;

        await bindProspectiveCapture(tx, vault, doc, input.now);

        let existing = await tx
          .select()
          .from(vaultServerCandidates)
          .where(eq(vaultServerCandidates.vaultId, input.vaultId))
          .for('update');
        const expiredIds = existing
          .filter((row) => row.expiresAt.getTime() <= input.now.getTime())
          .map((row) => row.id);
        if (expiredIds.length > 0) {
          await disposeCandidates(tx, expiredIds);
          existing = existing.filter((row) => !expiredIds.includes(row.id));
        }
        if (existing.some((row) => row.transitionId !== input.transitionId)) {
          await tx
            .delete(vaultServerCandidates)
            .where(eq(vaultServerCandidates.vaultId, input.vaultId));
          existing = [];
        }
        const sameDoc = existing.find((row) => row.docId === input.docId);
        if (
          sameDoc &&
          sameDoc.transitionId === input.transitionId &&
          sameDoc.version === input.header.docVersion &&
          sameBytes(sameDoc.blob, input.blob)
        ) {
          return { status: 'ok', row: sameDoc, idempotent: true } as const;
        }
        if (sameDoc) {
          await tx.delete(vaultServerCandidates).where(eq(vaultServerCandidates.id, sameDoc.id));
        }
        const [row] = await tx
          .insert(vaultServerCandidates)
          .values({
            transitionId: input.transitionId,
            vaultId: input.vaultId,
            docId: input.docId,
            version: input.header.docVersion,
            formatVersion: input.header.formatVersion,
            sizeBytes: input.blob.length,
            blob: input.blob,
            createdAt: input.now,
            expiresAt: input.expiresAt,
          })
          .returning();
        if (!row) throw new Error('candidate insert returned no row');

        // In a Drive-only E4 capture these inactive rows are the server's
        // exact-roster proof for the destructive commit. A changed candidate
        // after a successful refresh makes that proof stale. Preserve a
        // byte-identical retry above, and leave ordinary E1 promotion staging
        // alone when no prospective capture is bound to this vault.
        if (
          vault.mediaAttestedAt !== null &&
          (await hasLiveBoundProspectiveCapture(tx, vault, input.now))
        ) {
          await tx
            .update(vaults)
            .set({
              mediaAttestedAt: null,
              mediaAttestedDriveConnectionId: null,
              updatedAt: input.now,
            })
            .where(eq(vaults.id, input.vaultId));
        }
        return { status: 'ok', row, idempotent: false } as const;
      });
    },

    async getServerCandidate(userId, vaultId, candidateId, now) {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const [candidate] = await tx
          .select({ candidate: vaultServerCandidates, vault: vaults })
          .from(vaultServerCandidates)
          .innerJoin(vaults, eq(vaults.id, vaultServerCandidates.vaultId))
          .where(
            and(
              eq(vaults.userId, userId),
              eq(vaults.id, vaultId),
              eq(vaultServerCandidates.id, candidateId),
            ),
          )
          .for('update');
        if (!candidate) return null;
        if (candidate.candidate.expiresAt.getTime() <= now.getTime()) {
          await disposeCandidates(tx, [candidateId]);
          return null;
        }
        if (!(await expectedDoc(tx, candidate.vault, candidate.candidate.docId, { now }))) {
          return null;
        }
        return candidate.candidate;
      });
    },

    async cleanupExpiredServerCandidates(expiresAtOrBefore, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) return 0;
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        // Oldest expiry first, locked before disposal: a staging write racing
        // this sweep either waits behind the lock or inserts a fresh row the
        // selection never saw.
        const expired = await tx
          .select({ id: vaultServerCandidates.id })
          .from(vaultServerCandidates)
          .where(lte(vaultServerCandidates.expiresAt, expiresAtOrBefore))
          .orderBy(asc(vaultServerCandidates.expiresAt), asc(vaultServerCandidates.id))
          .limit(limit)
          .for('update');
        return disposeCandidates(
          tx,
          expired.map((row) => row.id),
        );
      });
    },

    async transitionMedia(input) {
      try {
        return await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Database;
          const [vault] = await tx
            .select()
            .from(vaults)
            .where(and(eq(vaults.id, input.vaultId), eq(vaults.userId, input.userId)))
            .for('update');
          if (!vault) return { status: 'not_found' as const };
          const current = await mediaState(tx, vault, input.now, true);
          if (
            input.request.expected.media.includes('local') ||
            input.request.next.media.includes('local')
          )
            return { status: 'reserved_medium' as const };
          const added = input.request.next.media.filter(
            (medium) => !input.request.expected.media.includes(medium),
          );
          const removed = input.request.expected.media.filter(
            (medium) => !input.request.next.media.includes(medium),
          );
          const connectionChanged =
            input.request.expected.driveConnectionId !== input.request.next.driveConnectionId;
          const replacingDrive = added.length === 0 && removed.length === 0 && connectionChanged;
          const refreshingAttestation =
            added.length === 0 && removed.length === 0 && !connectionChanged;
          if (
            connectionChanged &&
            !replacingDrive &&
            added[0] !== 'drive' &&
            removed[0] !== 'drive'
          ) {
            return { status: 'state_conflict', current } as const;
          }
          const roster = await expectedDocs(tx, vault, input.now);
          const activeRows = await tx
            .select()
            .from(vaultBlobs)
            .where(eq(vaultBlobs.vaultId, input.vaultId))
            .orderBy(asc(vaultBlobs.docId))
            .for('update');
          const refreshCandidates =
            refreshingAttestation &&
            vault.media.includes('drive') &&
            !vault.media.includes('server')
              ? await tx
                  .select()
                  .from(vaultServerCandidates)
                  .where(eq(vaultServerCandidates.vaultId, input.vaultId))
                  .orderBy(asc(vaultServerCandidates.docId))
                  .for('update')
              : [];
          const exactDriveOnlyRefreshCandidates =
            refreshCandidates.length > 0 &&
            exactCandidateRoster(roster, refreshCandidates, {
              vaultId: input.vaultId,
              transitionId: input.request.transitionId,
              now: input.now,
            });

          // Preserve v1's retry semantics for every transition whose durable
          // post-state can still be tied to the submitted full-set attestation.
          // Candidate promotion is intentionally excluded because promotion
          // deletes its candidate ids, so a lost response cannot be identified
          // safely after the fact.
          const targetAlreadyApplied =
            mediaEqual(vault.media, input.request.next.media) &&
            vault.driveConnectionId === input.request.next.driveConnectionId &&
            vault.mediaAttestedAt !== null &&
            vault.mediaAttestedDriveConnectionId ===
              (input.request.next.media.includes('drive')
                ? input.request.next.driveConnectionId
                : null) &&
            (current.server.candidates.length === 0 ||
              (refreshingAttestation &&
                vault.media.includes('drive') &&
                !vault.media.includes('server'))) &&
            // Before a same-selection refresh the target necessarily already
            // equals `next`; the changed attestation CAS stamp distinguishes a
            // retry from the first application.
            (!refreshingAttestation ||
              vault.mediaAttestedAt.toISOString() !== input.request.expected.mediaAttestedAt);
          const replayVerification = input.request.verification;
          if (targetAlreadyApplied && replayVerification.kind !== 'server-candidates') {
            let verified = false;
            if (refreshingAttestation && vault.media.includes('server')) {
              const requiredKind = vault.media.includes('drive') ? 'drive' : 'server';
              verified =
                replayVerification.kind === requiredKind &&
                exactRoster(roster, activeRows) &&
                attestationsEqual(replayVerification.docs, activeRows);
            } else if (refreshingAttestation && vault.media.includes('drive')) {
              verified =
                replayVerification.kind === 'drive' &&
                replayVerification.driveConnectionId === vault.driveConnectionId &&
                exactDriveOnlyRefreshCandidates &&
                attestationsEqual(replayVerification.docs, refreshCandidates);
            } else if (activeRows.length > 0) {
              verified =
                exactRoster(roster, activeRows) &&
                attestationsEqual(replayVerification.docs, activeRows);
            } else if (replayVerification.kind === 'drive') {
              // With no server copy, only the exact vault roster is a server
              // fact. docVersion/writeId stay signed client facts; R2 forbids
              // inferring freshness from their numeric values.
              verified = attestationRosterEqual(replayVerification.docs, roster);
            }
            if (verified) return { status: 'ok', state: current, idempotent: true } as const;
          }

          if (
            !mediaEqual(vault.media, input.request.expected.media) ||
            vault.driveConnectionId !== input.request.expected.driveConnectionId ||
            (vault.mediaAttestedAt?.toISOString() ?? null) !==
              input.request.expected.mediaAttestedAt
          ) {
            return { status: 'state_conflict', current } as const;
          }

          if (input.request.next.driveConnectionId) {
            const [connection] = await tx
              .select({ id: driveConnections.id })
              .from(driveConnections)
              .where(
                and(
                  eq(driveConnections.id, input.request.next.driveConnectionId),
                  eq(driveConnections.userId, input.userId),
                ),
              )
              .limit(1);
            if (!connection) return { status: 'drive_not_found', current } as const;
          }
          if (refreshingAttestation) {
            const verification = input.request.verification;
            if (vault.media.includes('server')) {
              if (!exactRoster(roster, activeRows)) {
                return { status: 'partial_set', current } as const;
              }
              const requiredKind = vault.media.includes('drive') ? 'drive' : 'server';
              if (
                verification.kind !== requiredKind ||
                (verification.kind === 'drive' &&
                  verification.driveConnectionId !== vault.driveConnectionId) ||
                !attestationsEqual(verification.docs, activeRows)
              ) {
                return { status: 'verification_failed', current } as const;
              }
            } else {
              if (!exactDriveOnlyRefreshCandidates) {
                return { status: 'partial_set', current } as const;
              }
              if (
                verification.kind !== 'drive' ||
                verification.driveConnectionId !== vault.driveConnectionId ||
                !attestationsEqual(verification.docs, refreshCandidates)
              ) {
                return { status: 'verification_failed', current } as const;
              }
            }

            const [updated] = await tx
              .update(vaults)
              .set({
                mediaAttestedAt: input.now,
                mediaAttestedDriveConnectionId: vault.media.includes('drive')
                  ? vault.driveConnectionId
                  : null,
                updatedAt: input.now,
              })
              .where(eq(vaults.id, input.vaultId))
              .returning();
            if (!updated) throw new Error('vault attestation refresh returned no row');
            return {
              status: 'ok',
              state: await mediaState(tx, updated, input.now, false),
              idempotent: false,
            } as const;
          }
          if (added[0] === 'server') {
            const [pendingRetirement] = await tx
              .select({ vaultId: vaultRetirements.vaultId })
              .from(vaultRetirements)
              .where(eq(vaultRetirements.vaultId, input.vaultId))
              .for('update');
            if (pendingRetirement) {
              // A retained recovery set must pass its signed purge gate before
              // server can become active again. Allowing promotion here would
              // make purge, deletion, and another retirement all refuse. Drop
              // the now-unusable staging batch as part of the refusal so the
              // signed purge can proceed immediately; re-add starts a fresh
              // batch only after that gate succeeds.
              await tx
                .delete(vaultServerCandidates)
                .where(eq(vaultServerCandidates.vaultId, input.vaultId));
              return {
                status: 'retirement_pending',
                current: await mediaState(tx, vault, input.now, false),
              } as const;
            }
            const candidates = await tx
              .select()
              .from(vaultServerCandidates)
              .where(eq(vaultServerCandidates.vaultId, input.vaultId))
              .orderBy(asc(vaultServerCandidates.docId))
              .for('update');
            const verification = input.request.verification;
            const exactCandidates =
              activeRows.length === 0 &&
              exactCandidateRoster(roster, candidates, {
                vaultId: input.vaultId,
                transitionId: input.request.transitionId,
                now: input.now,
              }) &&
              verification.kind === 'server-candidates' &&
              verification.readbacks.length === candidates.length &&
              candidates.every((candidate) => {
                const receipt = verification.readbacks.find(
                  (entry) => entry.candidateId === candidate.id && entry.docId === candidate.docId,
                );
                return receipt !== undefined && input.verifiedCandidateIds.has(candidate.id);
              });
            if (!exactCandidates) return { status: 'partial_set', current } as const;
            for (const candidate of candidates) {
              const header = headerOf(candidate);
              const expected = roster.find((doc) => doc.docId === candidate.docId)!;
              await tx.insert(vaultBlobs).values({
                vaultId: input.vaultId,
                docId: candidate.docId,
                docKind: header.docKind,
                portfolioId: expected.portfolioId,
                version: candidate.version,
                formatVersion: candidate.formatVersion,
                sizeBytes: candidate.sizeBytes,
                blob: candidate.blob,
                createdAt: input.now,
                updatedAt: input.now,
              });
            }
            await tx
              .delete(vaultServerCandidates)
              .where(eq(vaultServerCandidates.vaultId, input.vaultId));
          } else {
            const verification = input.request.verification;
            const driveOnlyReplacement =
              replacingDrive && !input.request.expected.media.includes('server');
            if (driveOnlyReplacement) {
              if (current.server.candidates.length > 0 || activeRows.length > 0) {
                return { status: 'state_conflict', current } as const;
              }
              if (verification.kind !== 'drive') {
                return { status: 'verification_failed', current } as const;
              }
              if (!attestationRosterEqual(verification.docs, roster)) {
                return { status: 'verification_failed', current } as const;
              }
            } else if (!exactRoster(roster, activeRows)) {
              return { status: 'partial_set', current } as const;
            } else if (
              (verification.kind !== 'drive' && verification.kind !== 'server') ||
              !attestationsEqual(verification.docs, activeRows)
            ) {
              return { status: 'verification_failed', current } as const;
            }
          }

          let nextGeneration = vault.retirementGeneration;
          if (removed[0] === 'server') {
            const history = await tx
              .select()
              .from(vaultBlobHistory)
              .where(eq(vaultBlobHistory.vaultId, input.vaultId))
              .for('update');
            const entries = [] as Array<(typeof activeRows)[number] | (typeof history)[number]>;
            const entriesByVersion = new Map<
              string,
              (typeof activeRows)[number] | (typeof history)[number]
            >();
            for (const entry of [...activeRows, ...history]) {
              const key = `${entry.docId}:${entry.version}`;
              const duplicate = entriesByVersion.get(key);
              if (duplicate) {
                // docVersion is client-owned and may be reused. The retired PK
                // can represent one byte string for a pair, so byte-identical
                // duplicates collapse while an ambiguous pair refuses cleanly.
                if (!sameBytes(duplicate.blob, entry.blob)) {
                  return { status: 'retirement_conflict', current } as const;
                }
                continue;
              }
              entriesByVersion.set(key, entry);
              entries.push(entry);
            }
            const existing = await tx
              .select()
              .from(vaultRetired)
              .where(eq(vaultRetired.vaultId, input.vaultId))
              .for('update');
            for (const entry of entries) {
              const conflict = existing.find(
                (row) => row.docId === entry.docId && row.version === entry.version,
              );
              if (conflict && !sameBytes(conflict.blob, entry.blob)) {
                return { status: 'retirement_conflict', current } as const;
              }
            }
            for (const entry of entries) {
              if (
                existing.some((row) => row.docId === entry.docId && row.version === entry.version)
              ) {
                continue;
              }
              await tx.insert(vaultRetired).values({
                vaultId: input.vaultId,
                docId: entry.docId,
                version: entry.version,
                formatVersion: entry.formatVersion,
                sizeBytes: entry.sizeBytes,
                blob: entry.blob,
                createdAt: entry.createdAt,
                retiredAt: input.now,
              });
            }
            nextGeneration += 1;
            await tx
              .insert(vaultRetirements)
              .values({
                vaultId: input.vaultId,
                retirementProofPublicKey: vault.retirementProofPublicKey,
                generation: nextGeneration,
                retiredAt: input.now,
              })
              .onConflictDoUpdate({
                target: vaultRetirements.vaultId,
                set: {
                  // The verifier is pinned by the first still-unpurged
                  // retirement. A later generation can extend that same
                  // aggregate set, but must never re-bind its purge gate.
                  generation: nextGeneration,
                  retiredAt: input.now,
                },
              });
            await tx.delete(vaultBlobHistory).where(eq(vaultBlobHistory.vaultId, input.vaultId));
            await tx.delete(vaultBlobs).where(eq(vaultBlobs.vaultId, input.vaultId));
          }

          const [updated] = await tx
            .update(vaults)
            .set({
              media: input.request.next.media,
              driveConnectionId: input.request.next.driveConnectionId,
              retirementGeneration: nextGeneration,
              mediaAttestedAt: input.now,
              mediaAttestedDriveConnectionId: input.request.next.media.includes('drive')
                ? input.request.next.driveConnectionId
                : null,
              updatedAt: input.now,
            })
            .where(eq(vaults.id, input.vaultId))
            .returning();
          if (!updated) throw new Error('vault media update returned no row');
          return {
            status: 'ok',
            state: await mediaState(tx, updated, input.now, false),
            idempotent: false,
          } as const;
        });
      } catch (error) {
        const constraint = foreignKeyConstraint(error);
        if (
          constraint !== 'vault_blobs_portfolio_id_portfolios_id_fk' &&
          constraint !== 'vaults_drive_connection_id_drive_connections_id_fk' &&
          constraint !== 'vaults_media_attested_drive_connection_fk'
        ) {
          throw error;
        }
        const vault = await findOwnedVault(input.userId, input.vaultId);
        if (!vault) return { status: 'not_found' };
        const current = await mediaState(db, vault, input.now, false);
        return constraint === 'vault_blobs_portfolio_id_portfolios_id_fk'
          ? { status: 'partial_set', current }
          : { status: 'drive_not_found', current };
      }
    },

    async getRetirementState(userId, vaultId) {
      const [vault] = await db
        .select({ id: vaults.id })
        .from(vaults)
        .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)))
        .limit(1);
      if (!vault) return null;
      const [retirement] = await db
        .select()
        .from(vaultRetirements)
        .where(eq(vaultRetirements.vaultId, vaultId))
        .limit(1);
      if (!retirement) return null;
      const rows = await db.select().from(vaultRetired).where(eq(vaultRetired.vaultId, vaultId));
      return {
        vaultId,
        generation: retirement.generation,
        versionSetHash: versionSetHash(rows),
        retirementProofPublicKey: retirement.retirementProofPublicKey,
        retiredAt: retirement.retiredAt,
        purgeAfter: new Date(
          retirement.retiredAt.getTime() + VAULT_RETIRED_SERVER_MIN_RETENTION_MS,
        ),
      };
    },

    async purgeRetired(input) {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const [vault] = await tx
          .select()
          .from(vaults)
          .where(and(eq(vaults.id, input.vaultId), eq(vaults.userId, input.userId)))
          .for('update');
        if (!vault) return { status: 'not_found' as const };
        let candidates = await tx
          .select()
          .from(vaultServerCandidates)
          .where(eq(vaultServerCandidates.vaultId, input.vaultId))
          .for('update');
        const expiredIds = candidates
          .filter((row) => row.expiresAt.getTime() <= input.now.getTime())
          .map((row) => row.id);
        if (expiredIds.length > 0) {
          await tx
            .delete(vaultServerCandidates)
            .where(inArray(vaultServerCandidates.id, expiredIds));
          candidates = candidates.filter((row) => !expiredIds.includes(row.id));
        }
        const [retirement] = await tx
          .select()
          .from(vaultRetirements)
          .where(eq(vaultRetirements.vaultId, input.vaultId))
          .for('update');
        if (!retirement) return { status: 'not_found' as const };
        const rows = await tx
          .select()
          .from(vaultRetired)
          .where(eq(vaultRetired.vaultId, input.vaultId))
          .for('update');
        if (
          vault.media.includes('server') ||
          candidates.length > 0 ||
          retirement.generation !== input.generation ||
          versionSetHash(rows) !== input.versionSetHash
        ) {
          return { status: 'state_conflict' as const };
        }
        // The hash above binds every retained server (docId, docVersion)
        // tuple. The separately signed observation binds a fresh read of the
        // surviving medium. With non-linear client versions, the blind server
        // can validate exact roster coverage but must never manufacture a
        // numeric "latest" version from the retired history set (R2).
        const roster = await expectedDocs(tx, vault, input.now);
        if (!attestationRosterEqual(input.observedDocs, roster)) {
          return { status: 'partial_set' as const };
        }
        const purgeAfter = new Date(
          retirement.retiredAt.getTime() + VAULT_RETIRED_SERVER_MIN_RETENTION_MS,
        );
        if (input.now.getTime() < purgeAfter.getTime()) {
          return { status: 'retention_pending', purgeAfter } as const;
        }
        if (!input.proofVerified) return { status: 'state_conflict' as const };
        await tx.delete(vaultRetired).where(eq(vaultRetired.vaultId, input.vaultId));
        await tx.delete(vaultRetirements).where(eq(vaultRetirements.vaultId, input.vaultId));
        return { status: 'ok' as const };
      });
    },
  };
}
