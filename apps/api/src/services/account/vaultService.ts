import {
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

import {
  readVaultDocServerHeader,
  serializePerVaultRetiredServerPurgeTranscript,
  PER_VAULT_ERROR_CODES,
  VAULT_RETIRED_PURGE_CHALLENGE_TTL_MS,
  VAULT_SERVER_CANDIDATE_TTL_MS,
  VaultEnvelopeError,
  type CreateVaultRequest,
  type DeleteVaultRequest,
  type PatchVaultRequest,
  type PerVaultMediaState,
  type PerVaultMediaTransitionRequest,
  type PerVaultRetiredServerPurgeChallengeRequest,
  type PerVaultRetiredServerPurgeChallengeResponse,
  type PerVaultRetiredServerPurgeRequest,
  type PerVaultServerCandidateMetadata,
  type VaultConfig,
  type VaultDocKind,
  type VaultHistoryListQuery,
  type VaultHistoryListResponse,
} from '@bettertrack/contracts';

import {
  LegacyVaultCandidateError,
  type VaultBlobReadResult,
  type VaultBlobRepository,
  type VaultBlobRetention,
  type VaultBlobWriteResult,
  type VaultCandidateResult,
  type VaultMediaTransitionResult,
  type VaultRetiredPurgeResult,
} from '../../data/repositories/vaultBlobRepository';
import type {
  VaultCreateResult,
  VaultDeleteResult,
  VaultPatchResult,
  VaultRepository,
} from '../../data/repositories/vaultRepository';
import type { VaultServerCandidateRow } from '../../data/schema';
import { ApiError } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import type { VaultDeleteReauth } from './paranoidDiscardReauth';

export interface VaultServiceDeps {
  configs: VaultRepository;
  blobs: VaultBlobRepository;
  docMaxBytes: Record<VaultDocKind, number>;
  retention: VaultBlobRetention;
  proofSecret?: string;
  now?: () => Date;
  audit: AuditService;
  deleteReauth: VaultDeleteReauth;
}

export type VaultDocPutResult =
  | VaultBlobWriteResult
  | { status: 'too_large'; sizeBytes: number; maxBytes: number }
  | { status: 'malformed'; reason: string }
  | { status: 'address_mismatch' };

export type VaultCandidateStageResult =
  | VaultCandidateResult
  | { status: 'too_large'; sizeBytes: number; maxBytes: number }
  | { status: 'malformed'; reason: string }
  | { status: 'address_mismatch' };

export type VaultPurgeChallengeResult =
  | { status: 'ok'; challenge: PerVaultRetiredServerPurgeChallengeResponse }
  | { status: 'not_found' }
  | { status: 'state_conflict' }
  | { status: 'proof_unavailable' };

export type VaultPurgeResult =
  | VaultRetiredPurgeResult
  | { status: 'proof_invalid' }
  | { status: 'state_conflict' };

export interface VaultService {
  list(userId: string): Promise<VaultConfig[]>;
  get(userId: string, vaultId: string): Promise<VaultConfig | null>;
  create(userId: string, body: CreateVaultRequest, ip?: string | null): Promise<VaultCreateResult>;
  patch(
    userId: string,
    vaultId: string,
    body: PatchVaultRequest,
    ip?: string | null,
  ): Promise<VaultPatchResult>;
  delete(input: {
    userId: string;
    vaultId: string;
    body: DeleteVaultRequest;
    ip?: string | null;
  }): Promise<VaultDeleteResult>;
  readDoc(userId: string, vaultId: string, docId: string): Promise<VaultBlobReadResult>;
  putDoc(input: {
    userId: string;
    vaultId: string;
    docId: string;
    expectedVersion: number | null;
    blob: Buffer;
  }): Promise<VaultDocPutResult>;
  listHistory(
    userId: string,
    vaultId: string,
    docId: string,
    query: VaultHistoryListQuery,
  ): Promise<{ status: 'ok'; page: VaultHistoryListResponse } | { status: 'not_found' }>;
  getHistory(
    userId: string,
    vaultId: string,
    docId: string,
    version: number,
  ): ReturnType<VaultBlobRepository['getHistory']>;
  getMediaState(userId: string, vaultId: string): Promise<PerVaultMediaState | null>;
  stageServerCandidate(input: {
    userId: string;
    vaultId: string;
    transitionId: string;
    docId: string;
    blob: Buffer;
  }): Promise<
    | { status: 'ok'; candidate: PerVaultServerCandidateMetadata; idempotent: boolean }
    | Exclude<VaultCandidateStageResult, { status: 'ok' }>
  >;
  getServerCandidate(
    userId: string,
    vaultId: string,
    candidateId: string,
  ): Promise<VaultServerCandidateRow | null>;
  issueCandidateReadback(
    userId: string,
    vaultId: string,
    candidate: VaultServerCandidateRow,
  ): string | null;
  transitionMedia(
    userId: string,
    vaultId: string,
    request: PerVaultMediaTransitionRequest,
    ip?: string | null,
  ): Promise<VaultMediaTransitionResult>;
  prepareRetiredPurge(
    userId: string,
    vaultId: string,
    request: PerVaultRetiredServerPurgeChallengeRequest,
  ): Promise<VaultPurgeChallengeResult>;
  purgeRetired(
    userId: string,
    vaultId: string,
    request: PerVaultRetiredServerPurgeRequest,
    ip?: string | null,
  ): Promise<VaultPurgeResult>;
}

interface OpaqueTokenPayload {
  purpose: string;
  [key: string]: string | number;
}

function signOpaqueToken(
  secret: string,
  purpose: string,
  payload: Record<string, string | number>,
): string {
  const encoded = Buffer.from(JSON.stringify({ purpose, ...payload })).toString('base64url');
  const mac = createHmac('sha256', secret).update(`${purpose}.${encoded}`).digest('base64url');
  return `${encoded}.${mac}`;
}

function verifyOpaqueToken(
  secret: string | undefined,
  purpose: string,
  token: string,
): OpaqueTokenPayload | null {
  if (!secret) return null;
  const [encoded, suppliedMac, extra] = token.split('.');
  if (!encoded || !suppliedMac || extra !== undefined) return null;
  const expectedMac = createHmac('sha256', secret)
    .update(`${purpose}.${encoded}`)
    .digest('base64url');
  const expected = Buffer.from(expectedMac);
  const supplied = Buffer.from(suppliedMac);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    return parsed &&
      typeof parsed === 'object' &&
      (parsed as { purpose?: unknown }).purpose === purpose
      ? (parsed as OpaqueTokenPayload)
      : null;
  } catch {
    return null;
  }
}

function candidateMetadata(row: VaultServerCandidateRow): PerVaultServerCandidateMetadata {
  const header = readVaultDocServerHeader(row.blob);
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

function legacyCandidateRefusal(): ApiError {
  return new ApiError(
    409,
    PER_VAULT_ERROR_CODES.mediaStateConflict,
    'A legacy server candidate has no transition identity and must be re-staged.',
  );
}

function verifyRetiredSignature(
  publicKeyBase64Url: string,
  input: PerVaultRetiredServerPurgeRequest,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64Url, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return (
      key.asymmetricKeyType === 'ed25519' &&
      verifySignature(
        null,
        Buffer.from(serializePerVaultRetiredServerPurgeTranscript(input)),
        key,
        Buffer.from(input.signature, 'base64url'),
      )
    );
  } catch {
    return false;
  }
}

export function createVaultService(deps: VaultServiceDeps): VaultService {
  const now = deps.now ?? (() => new Date());

  return {
    list(userId) {
      return deps.configs.list(userId);
    },

    get(userId, vaultId) {
      return deps.configs.find(userId, vaultId);
    },

    async create(userId, body, ip) {
      const result = await deps.configs.create({ userId, ...body });
      if (result.status === 'ok') {
        await deps.audit.record({
          actorId: userId,
          action: AuditAction.VaultCreated,
          targetType: 'vault',
          targetId: result.vault.id,
          ip,
          meta: { media: result.vault.media },
        });
      }
      return result;
    },

    async patch(userId, vaultId, body, ip) {
      const result = await deps.configs.patch(userId, vaultId, body.name!);
      if (result.status === 'ok') {
        await deps.audit.record({
          actorId: userId,
          action: AuditAction.VaultUpdated,
          targetType: 'vault',
          targetId: vaultId,
          ip,
          meta: { fields: ['name'] },
        });
      }
      return result;
    },

    async delete({ userId, vaultId, body, ip }) {
      try {
        const result = await deps.configs.delete({
          userId,
          vaultId,
          verifyStepUp: (auth, tx) =>
            deps.deleteReauth.verifyVaultDelete({
              userId,
              vaultId,
              body: body.stepUp,
              ip,
              auth,
              db: tx,
            }),
        });
        if (result.status === 'ok') {
          await deps.audit.record({
            actorId: userId,
            action: AuditAction.VaultDeleted,
            targetType: 'vault',
            targetId: vaultId,
            ip,
          });
        }
        return result;
      } catch (error) {
        await deps.deleteReauth.recordVaultDeleteFailure(error);
        throw error;
      }
    },

    readDoc(userId, vaultId, docId) {
      return deps.blobs.readCurrent(userId, vaultId, docId);
    },

    async putDoc(input) {
      let header;
      try {
        // R2 is deliberately the only cleartext projection available here.
        // The ciphertext that follows is never decoded, JSON-parsed, logged, or indexed.
        header = readVaultDocServerHeader(input.blob);
      } catch (error) {
        if (error instanceof VaultEnvelopeError) {
          return { status: 'malformed', reason: error.message };
        }
        throw error;
      }
      if (header.vaultId !== input.vaultId || header.docId !== input.docId) {
        return { status: 'address_mismatch' };
      }
      const maxBytes = deps.docMaxBytes[header.docKind];
      if (input.blob.length > maxBytes) {
        return { status: 'too_large', sizeBytes: input.blob.length, maxBytes };
      }
      return deps.blobs.compareAndSwap({
        ...input,
        header,
        retention: deps.retention,
        now: now(),
      });
    },

    async listHistory(userId, vaultId, docId, query) {
      const result = await deps.blobs.listHistory({ userId, vaultId, docId, ...query });
      if (result.status === 'not_found') return result;
      return {
        status: 'ok',
        page: {
          items: result.value.items.map((row) => ({
            version: row.version,
            createdAt: row.createdAt.toISOString(),
            sizeBytes: row.sizeBytes,
            medium: 'server' as const,
          })),
          nextCursor: result.value.nextCursor,
        },
      };
    },

    getHistory(userId, vaultId, docId, version) {
      return deps.blobs.getHistory(userId, vaultId, docId, version);
    },

    async getMediaState(userId, vaultId) {
      try {
        return await deps.blobs.getMediaState(userId, vaultId, now());
      } catch (error) {
        if (error instanceof LegacyVaultCandidateError) throw legacyCandidateRefusal();
        throw error;
      }
    },

    async stageServerCandidate(input) {
      let header;
      try {
        header = readVaultDocServerHeader(input.blob);
      } catch (error) {
        if (error instanceof VaultEnvelopeError) {
          return { status: 'malformed', reason: error.message };
        }
        throw error;
      }
      if (header.vaultId !== input.vaultId || header.docId !== input.docId) {
        return { status: 'address_mismatch' };
      }
      const maxBytes = deps.docMaxBytes[header.docKind];
      if (input.blob.length > maxBytes) {
        return { status: 'too_large', sizeBytes: input.blob.length, maxBytes };
      }
      const stagedAt = now();
      const result = await deps.blobs.stageServerCandidate({
        ...input,
        header,
        now: stagedAt,
        expiresAt: new Date(stagedAt.getTime() + VAULT_SERVER_CANDIDATE_TTL_MS),
      });
      if (result.status !== 'ok') return result;
      try {
        return {
          status: 'ok',
          candidate: candidateMetadata(result.row),
          idempotent: result.idempotent,
        };
      } catch (error) {
        if (error instanceof LegacyVaultCandidateError) throw legacyCandidateRefusal();
        throw error;
      }
    },

    getServerCandidate(userId, vaultId, candidateId) {
      return deps.blobs.getServerCandidate(userId, vaultId, candidateId, now());
    },

    issueCandidateReadback(userId, vaultId, candidate) {
      if (!candidate.transitionId) throw legacyCandidateRefusal();
      if (!deps.proofSecret) return null;
      const header = readVaultDocServerHeader(candidate.blob);
      return signOpaqueToken(deps.proofSecret, 'per-vault-candidate-readback', {
        userId,
        vaultId,
        transitionId: candidate.transitionId,
        candidateId: candidate.id,
        docId: candidate.docId,
        docVersion: candidate.version,
        writeId: header.writeId,
        expiresAt: candidate.expiresAt.getTime(),
      });
    },

    async transitionMedia(userId, vaultId, request, ip) {
      const at = now();
      const verifiedCandidateIds = new Set<string>();
      if (request.verification.kind === 'server-candidates') {
        for (const receipt of request.verification.readbacks) {
          const payload = verifyOpaqueToken(
            deps.proofSecret,
            'per-vault-candidate-readback',
            receipt.readback,
          );
          if (
            payload?.userId === userId &&
            payload.vaultId === vaultId &&
            payload.transitionId === request.transitionId &&
            payload.candidateId === receipt.candidateId &&
            payload.docId === receipt.docId &&
            typeof payload.expiresAt === 'number' &&
            payload.expiresAt > at.getTime()
          ) {
            verifiedCandidateIds.add(receipt.candidateId);
          }
        }
      }
      let result: VaultMediaTransitionResult;
      try {
        result = await deps.blobs.transitionMedia({
          userId,
          vaultId,
          request,
          verifiedCandidateIds,
          now: at,
        });
      } catch (error) {
        if (error instanceof LegacyVaultCandidateError) throw legacyCandidateRefusal();
        throw error;
      }
      if (result.status === 'ok' && !result.idempotent) {
        await deps.audit.record({
          actorId: userId,
          action: AuditAction.VaultMediaChanged,
          targetType: 'vault',
          targetId: vaultId,
          ip,
          meta: { media: result.state.media },
        });
      }
      return result;
    },

    async prepareRetiredPurge(userId, vaultId, request) {
      if (request.vaultId !== vaultId) return { status: 'state_conflict' };
      const retirement = await deps.blobs.getRetirementState(userId, vaultId);
      if (!retirement) return { status: 'not_found' };
      if (
        retirement.generation !== request.generation ||
        retirement.versionSetHash !== request.versionSetHash
      ) {
        return { status: 'state_conflict' };
      }
      if (!deps.proofSecret) return { status: 'proof_unavailable' };
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + VAULT_RETIRED_PURGE_CHALLENGE_TTL_MS);
      return {
        status: 'ok',
        challenge: {
          vaultId,
          generation: retirement.generation,
          versionSetHash: retirement.versionSetHash,
          challenge: signOpaqueToken(deps.proofSecret, 'per-vault-retired-purge', {
            userId,
            vaultId,
            generation: retirement.generation,
            versionSetHash: retirement.versionSetHash,
            expiresAt: expiresAt.getTime(),
            nonce: randomBytes(24).toString('base64url'),
          }),
          expiresAt: expiresAt.toISOString(),
        },
      };
    },

    async purgeRetired(userId, vaultId, request, ip) {
      if (request.vaultId !== vaultId) return { status: 'state_conflict' };
      const retirement = await deps.blobs.getRetirementState(userId, vaultId);
      if (!retirement) return { status: 'not_found' };
      if (
        retirement.generation !== request.generation ||
        retirement.versionSetHash !== request.versionSetHash
      ) {
        return { status: 'state_conflict' };
      }
      const challenge = verifyOpaqueToken(
        deps.proofSecret,
        'per-vault-retired-purge',
        request.challenge,
      );
      if (
        challenge?.userId !== userId ||
        challenge.vaultId !== vaultId ||
        challenge.generation !== request.generation ||
        challenge.versionSetHash !== request.versionSetHash ||
        typeof challenge.expiresAt !== 'number' ||
        challenge.expiresAt <= now().getTime() ||
        !verifyRetiredSignature(retirement.retirementProofPublicKey, request)
      ) {
        return { status: 'proof_invalid' };
      }
      const result = await deps.blobs.purgeRetired({
        userId,
        vaultId,
        generation: request.generation,
        versionSetHash: request.versionSetHash,
        observedDocs: request.observedDocs,
        proofVerified: true,
        now: now(),
      });
      if (result.status === 'ok') {
        await deps.audit.record({
          actorId: userId,
          action: AuditAction.VaultRetiredPurged,
          targetType: 'vault',
          targetId: vaultId,
          ip,
          meta: { generation: request.generation, versionSetHash: request.versionSetHash },
        });
      }
      return result;
    },
  };
}
