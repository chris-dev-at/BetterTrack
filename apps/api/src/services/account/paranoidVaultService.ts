import {
  readVaultServerHeader,
  VAULT_SERVER_CANDIDATE_TTL_MS,
  VaultEnvelopeError,
  type ParanoidMediaStatusResponse,
  type ParanoidServerCandidateMetadata,
  type PatchParanoidMediaRequest,
  type PrepareParanoidMediaVerificationRequest,
  type PrepareParanoidMediaVerificationResponse,
  type VaultHistoryListQuery,
  type VaultHistoryListResponse,
  type VaultMetadata,
} from '@bettertrack/contracts';

import type {
  ParanoidVaultRepository,
  ParanoidVaultRetention,
} from '../../data/repositories/paranoidVaultRepository';
import type {
  ParanoidVaultHistoryRow,
  ParanoidVaultRow,
  ParanoidVaultServerCandidateRow,
} from '../../data/schema';
import {
  PARANOID_MEDIA_PROOF_TTL_MS,
  proofMatchesRequest,
  signParanoidMediaProof,
  verifyParanoidMediaProof,
} from './paranoidMediaProof';

/**
 * Paranoid-vault service (§13.5 V5-P13 arc b, `docs/paranoid-design.md` §2, §4).
 * The business layer over the blind server blob store: it enforces the size cap,
 * reads ONLY the safe envelope header (`formatVersion` + `vaultVersion`) needed
 * for versioning — never the ciphertext — and drives the repository's atomic
 * compare-and-swap. It never decrypts, parses past that header, logs, or indexes
 * the payload.
 */

export interface ParanoidVaultServiceDeps {
  vaults: ParanoidVaultRepository;
  /** Server-enforced ciphertext (envelope) size cap in bytes (§2, env-tunable). */
  maxBytes: number;
  /** Bounded ciphertext history window (§4, env-tunable). */
  retention: ParanoidVaultRetention;
  /** Injected clock so archive/prune timestamps stay deterministic in tests. */
  now?: () => Date;
  /** First session-signing secret, domain-separated for short-lived media proofs. */
  proofSecret?: string;
}

export interface ParanoidVaultPutInput {
  userId: string;
  /**
   * CAS precondition: the version the client expects to be current (from
   * `If-Match`), or `null` to CREATE (from `If-None-Match: *`).
   */
  expectedVersion: number | null;
  /** The raw opaque envelope bytes to store. */
  blob: Buffer;
}

export type ParanoidVaultPutResult =
  | { status: 'ok'; version: number; updatedAt: Date }
  | { status: 'precondition_failed'; currentVersion: number | null }
  | { status: 'medium_inactive' }
  | { status: 'too_large'; sizeBytes: number; maxBytes: number }
  | { status: 'malformed'; reason: string };

export interface ParanoidVaultService {
  /** The current opaque blob + metadata, or `null` when none exists yet. */
  get(userId: string): Promise<ParanoidVaultRow | null>;
  /** Blob metadata only (version/size/format/updatedAt) — never any content. */
  getMetadata(userId: string): Promise<VaultMetadata | null>;
  /** Bounded newest-first metadata page; never selects ciphertext bytes. */
  listHistory(userId: string, input: VaultHistoryListQuery): Promise<VaultHistoryListResponse>;
  /** One owner-scoped retained opaque blob, or `null` when absent. */
  getHistory(userId: string, version: number): Promise<ParanoidVaultHistoryRow | null>;
  /** Compare-and-swap write. Never overwrites newer ciphertext. */
  put(input: ParanoidVaultPutInput): Promise<ParanoidVaultPutResult>;
  /** Portfolio-free durable media metadata for the caller's account. */
  getMediaState(userId: string): Promise<ParanoidMediaStatusResponse | null>;
  /** Mint a short-lived proof after checking the current locked server head. */
  prepareMediaVerification(
    userId: string,
    input: PrepareParanoidMediaVerificationRequest,
  ): Promise<
    | { status: 'ok'; proof: PrepareParanoidMediaVerificationResponse }
    | Exclude<
        Awaited<ReturnType<ParanoidVaultRepository['verifyMediaTransition']>>,
        { status: 'ok' }
      >
  >;
  /**
   * One verified media-set transition. Removing server ciphertext is delegated
   * to the repository's account-row transaction.
   */
  patchMedia(
    userId: string,
    input: PatchParanoidMediaRequest,
  ): ReturnType<ParanoidVaultRepository['patchMedia']>;
  /** Store one inactive Drive-source candidate without activating server. */
  stageServerCandidate(
    userId: string,
    blob: Buffer,
  ): Promise<
    | { status: 'ok'; candidate: ParanoidServerCandidateMetadata; idempotent: boolean }
    | Exclude<
        Awaited<ReturnType<ParanoidVaultRepository['stageServerCandidate']>>,
        { status: 'ok' }
      >
    | { status: 'too_large'; sizeBytes: number; maxBytes: number }
    | { status: 'malformed'; reason: string }
  >;
  /** Read the exact inactive opaque candidate for browser authentication. */
  getServerCandidate(
    userId: string,
    candidateId: string,
  ): Promise<ParanoidVaultServerCandidateRow | null>;
  /** Best-effort cleanup after failed authentication or an abandoned switch. */
  discardServerCandidate(userId: string, candidateId: string): Promise<void>;
}

function metadataOf(row: ParanoidVaultRow): VaultMetadata {
  return {
    version: row.version,
    formatVersion: row.formatVersion,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function candidateMetadataOf(
  row: ParanoidVaultServerCandidateRow,
): ParanoidServerCandidateMetadata {
  return {
    candidateId: row.id,
    version: row.version,
    formatVersion: row.formatVersion,
    sizeBytes: row.sizeBytes,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export function createParanoidVaultService(deps: ParanoidVaultServiceDeps): ParanoidVaultService {
  const now = deps.now ?? (() => new Date());

  return {
    async get(userId) {
      return deps.vaults.getCurrent(userId);
    },

    async getMetadata(userId) {
      const row = await deps.vaults.getCurrent(userId);
      return row ? metadataOf(row) : null;
    },

    async listHistory(userId, input) {
      const page = await deps.vaults.listHistory(userId, input);
      return {
        items: page.items.map((row) => ({
          version: row.version,
          createdAt: row.createdAt.toISOString(),
          sizeBytes: row.sizeBytes,
          medium: 'server' as const,
        })),
        nextCursor: page.nextCursor,
      };
    },

    async getHistory(userId, version) {
      return deps.vaults.getHistory(userId, version);
    },

    async put({ userId, expectedVersion, blob }) {
      // Size cap FIRST — an oversized payload is rejected before any parse or
      // persistence.
      const inspected = inspectBlob(blob, deps.maxBytes);
      if ('status' in inspected) return inspected;
      const { header } = inspected;

      // The envelope's version must strictly advance the precondition — a
      // client always writes `last seen + 1` (or a merged max(parents)+1). A
      // non-advancing version is a malformed/stale write, never persisted.
      if (expectedVersion !== null && header.vaultVersion <= expectedVersion) {
        return {
          status: 'malformed',
          reason: 'envelope vaultVersion does not advance the If-Match version',
        };
      }

      const result = await deps.vaults.compareAndSwap({
        userId,
        expectedVersion,
        version: header.vaultVersion,
        formatVersion: header.formatVersion,
        sizeBytes: blob.length,
        blob,
        retention: deps.retention,
        now: now(),
      });
      return result;
    },

    async getMediaState(userId) {
      return deps.vaults.getMediaState(userId);
    },

    async prepareMediaVerification(userId, input) {
      const verified = await deps.vaults.verifyMediaTransition({ userId, ...input, now: now() });
      if (verified.status !== 'ok') return verified;
      if (!deps.proofSecret) {
        return { status: 'verification_failed', current: verified.current };
      }
      const expiresAt = new Date(now().getTime() + PARANOID_MEDIA_PROOF_TTL_MS);
      return {
        status: 'ok',
        proof: {
          proof: signParanoidMediaProof(deps.proofSecret, {
            userId,
            ...input,
            expiresAtMs: expiresAt.getTime(),
          }),
          expiresAt: expiresAt.toISOString(),
        },
      };
    },

    async patchMedia(userId, input) {
      const account = await deps.vaults.getMediaState(userId);
      if (!account) return { status: 'not_found' };
      if (account.privacyMode !== 'paranoid' || account.mediaState === null) {
        return { status: 'mode_required' };
      }
      if (!sameMediaState(account.mediaState, input.expected)) {
        return { status: 'state_conflict', current: account.mediaState };
      }
      const request = {
        expected: input.expected,
        nextMediaSet: input.nextMediaSet,
        verification: {
          medium: input.verification.medium,
          version: input.verification.version,
          ...(input.verification.serverCandidateId
            ? { serverCandidateId: input.verification.serverCandidateId }
            : {}),
        },
      };
      const proof = deps.proofSecret
        ? verifyParanoidMediaProof(deps.proofSecret, input.verification.proof, now().getTime())
        : null;
      if (!proof || !proofMatchesRequest(proof, userId, request)) {
        return { status: 'verification_failed', current: input.expected };
      }
      return deps.vaults.patchMedia({
        userId,
        expected: input.expected,
        nextMediaSet: input.nextMediaSet,
        verification: request.verification,
        proofVerified: true,
        now: now(),
      });
    },

    async stageServerCandidate(userId, blob) {
      const inspected = inspectBlob(blob, deps.maxBytes);
      if ('status' in inspected) return inspected;
      const stagedAt = now();
      const result = await deps.vaults.stageServerCandidate({
        userId,
        version: inspected.header.vaultVersion,
        formatVersion: inspected.header.formatVersion,
        sizeBytes: blob.length,
        blob,
        now: stagedAt,
        expiresAt: new Date(stagedAt.getTime() + VAULT_SERVER_CANDIDATE_TTL_MS),
      });
      return result.status === 'ok'
        ? {
            status: 'ok',
            candidate: candidateMetadataOf(result.candidate),
            idempotent: result.idempotent,
          }
        : result;
    },

    async getServerCandidate(userId, candidateId) {
      return deps.vaults.getServerCandidate(userId, candidateId, now());
    },

    async discardServerCandidate(userId, candidateId) {
      await deps.vaults.discardServerCandidate(userId, candidateId);
    },
  };
}

function sameMediaState(
  left: NonNullable<ParanoidMediaStatusResponse['mediaState']>,
  right: NonNullable<ParanoidMediaStatusResponse['mediaState']>,
): boolean {
  return (
    left.driveAttestedVersion === right.driveAttestedVersion &&
    left.mediaSet.length === right.mediaSet.length &&
    left.mediaSet.every((medium) => right.mediaSet.includes(medium))
  );
}

function inspectBlob(
  blob: Buffer,
  maxBytes: number,
):
  | { header: { formatVersion: number; vaultVersion: number } }
  | { status: 'too_large'; sizeBytes: number; maxBytes: number }
  | { status: 'malformed'; reason: string } {
  if (blob.length > maxBytes) {
    return { status: 'too_large', sizeBytes: blob.length, maxBytes };
  }
  try {
    return { header: readVaultServerHeader(blob) };
  } catch (err) {
    if (err instanceof VaultEnvelopeError) {
      return { status: 'malformed', reason: err.message };
    }
    throw err;
  }
}
