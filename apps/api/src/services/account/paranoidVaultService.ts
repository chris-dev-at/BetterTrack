import {
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

import {
  readVaultServerHeader,
  serializeRetiredServerPurgeTranscript,
  VAULT_RETIRED_PURGE_CHALLENGE_TTL_MS,
  VAULT_SERVER_CANDIDATE_TTL_MS,
  VaultEnvelopeError,
  type ParanoidMediaStateResponse,
  type ParanoidMediaTransitionRequest,
  type ParanoidServerCandidateMetadata,
  type RetiredServerPurgeChallengeRequest,
  type RetiredServerPurgeChallengeResponse,
  type RetiredServerPurgeRequest,
  type VaultHistoryListQuery,
  type VaultHistoryListResponse,
  type VaultMetadata,
} from '@bettertrack/contracts';

import type {
  ParanoidMediaTransitionResult,
  ParanoidRetiredPurgeResult,
  ParanoidStageServerCandidateResult,
  ParanoidVaultHistoryReadRow,
  ParanoidVaultRepository,
  ParanoidVaultRetention,
} from '../../data/repositories/paranoidVaultRepository';
import type { ParanoidVaultRow, ParanoidVaultServerCandidateRow } from '../../data/schema';

/**
 * Business layer for the blind server vault. The service reads only the safe
 * envelope header, issues opaque one-time-ish read-back receipts, and verifies
 * retirement purge transcripts. It never decrypts, parses portfolio payloads,
 * calls Drive, or receives a Drive token/file id/request.
 */
export interface ParanoidVaultServiceDeps {
  vaults: ParanoidVaultRepository;
  maxBytes: number;
  retention: ParanoidVaultRetention;
  now?: () => Date;
  /** Domain-separated HMAC key for short-lived candidate and purge challenges. */
  proofSecret?: string;
}

export interface ParanoidVaultPutInput {
  userId: string;
  expectedVersion: number | null;
  blob: Buffer;
  /**
   * Immutable public verifier accepted on the first active write, or once on
   * the next CAS update of a legacy keyless active vault.
   */
  retirementProofPublicKey?: string | null;
}

export type ParanoidVaultPutResult =
  | { status: 'ok'; version: number; updatedAt: Date }
  | { status: 'precondition_failed'; currentVersion: number | null }
  | { status: 'too_large'; sizeBytes: number; maxBytes: number }
  | { status: 'malformed'; reason: string }
  | { status: 'medium_inactive' }
  | { status: 'proof_key_conflict' };

export type RetiredPurgeChallengeResult =
  | { status: 'ok'; challenge: RetiredServerPurgeChallengeResponse }
  | { status: 'not_found' }
  | { status: 'state_conflict' }
  | { status: 'proof_required' };

export type RetiredPurgeResult =
  | ParanoidRetiredPurgeResult
  | { status: 'proof_invalid' }
  | { status: 'state_conflict' };

export interface ParanoidVaultService {
  get(userId: string): Promise<ParanoidVaultRow | null>;
  getMetadata(userId: string): Promise<VaultMetadata | null>;
  listHistory(userId: string, input: VaultHistoryListQuery): Promise<VaultHistoryListResponse>;
  getHistory(userId: string, version: number): Promise<ParanoidVaultHistoryReadRow | null>;
  put(input: ParanoidVaultPutInput): Promise<ParanoidVaultPutResult>;
  getMediaState(userId: string): Promise<ParanoidMediaStateResponse | null>;
  stageServerCandidate(
    userId: string,
    blob: Buffer,
    retirementProofPublicKey: string | null,
  ): Promise<
    | { status: 'ok'; candidate: ParanoidServerCandidateMetadata; idempotent: boolean }
    | Exclude<ParanoidStageServerCandidateResult, { status: 'ok' }>
    | { status: 'too_large'; sizeBytes: number; maxBytes: number }
    | { status: 'malformed'; reason: string }
  >;
  getServerCandidate(
    userId: string,
    candidateId: string,
  ): Promise<ParanoidVaultServerCandidateRow | null>;
  issueCandidateReadback(userId: string, candidate: ParanoidVaultServerCandidateRow): string | null;
  transitionMedia(
    userId: string,
    input: ParanoidMediaTransitionRequest,
  ): Promise<ParanoidMediaTransitionResult>;
  prepareRetiredPurge(
    userId: string,
    input: RetiredServerPurgeChallengeRequest,
  ): Promise<RetiredPurgeChallengeResult>;
  purgeRetired(userId: string, input: RetiredServerPurgeRequest): Promise<RetiredPurgeResult>;
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

    async put({ userId, expectedVersion, blob, retirementProofPublicKey = null }) {
      const inspected = inspectBlob(blob, deps.maxBytes);
      if ('status' in inspected) return inspected;
      if (expectedVersion !== null && inspected.header.vaultVersion <= expectedVersion) {
        return {
          status: 'malformed' as const,
          reason: 'envelope vaultVersion does not advance the If-Match version',
        };
      }
      return deps.vaults.compareAndSwap({
        userId,
        expectedVersion,
        version: inspected.header.vaultVersion,
        formatVersion: inspected.header.formatVersion,
        sizeBytes: blob.length,
        blob,
        retirementProofPublicKey,
        retention: deps.retention,
        now: now(),
      });
    },

    async getMediaState(userId) {
      return deps.vaults.getMediaState(userId);
    },

    async stageServerCandidate(userId, blob, retirementProofPublicKey) {
      const inspected = inspectBlob(blob, deps.maxBytes);
      if ('status' in inspected) return inspected;
      const stagedAt = now();
      const result = await deps.vaults.stageServerCandidate({
        userId,
        version: inspected.header.vaultVersion,
        formatVersion: inspected.header.formatVersion,
        sizeBytes: blob.length,
        blob,
        retirementProofPublicKey,
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

    issueCandidateReadback(userId, candidate) {
      if (!deps.proofSecret) return null;
      return signOpaqueToken(deps.proofSecret, 'candidate-readback', {
        userId,
        candidateId: candidate.id,
        version: candidate.version,
        expiresAt: candidate.expiresAt.getTime(),
      });
    },

    async transitionMedia(userId, input) {
      const candidateReadbackVerified =
        input.verification.kind !== 'server-candidate'
          ? false
          : verifyCandidateReadback(
              deps.proofSecret,
              input.verification.readback,
              userId,
              input.verification.candidateId,
              now().getTime(),
            );
      return deps.vaults.transitionMedia({
        userId,
        ...input,
        candidateReadbackVerified,
        now: now(),
      });
    },

    async prepareRetiredPurge(userId, input) {
      const retirement = await deps.vaults.getRetirementState(userId);
      if (!retirement) return { status: 'not_found' };
      if (retirement.retiredVersion !== input.retiredVersion) return { status: 'state_conflict' };
      if (!deps.proofSecret) return { status: 'proof_required' };
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + VAULT_RETIRED_PURGE_CHALLENGE_TTL_MS);
      return {
        status: 'ok',
        challenge: {
          retiredVersion: input.retiredVersion,
          challenge: signOpaqueToken(deps.proofSecret, 'retired-server-purge', {
            userId,
            retiredVersion: input.retiredVersion,
            expiresAt: expiresAt.getTime(),
            nonce: randomBytes(24).toString('base64url'),
          }),
          expiresAt: expiresAt.toISOString(),
        },
      };
    },

    async purgeRetired(userId, input) {
      if (input.observedVersion < input.retiredVersion) return { status: 'proof_invalid' };
      const retirement = await deps.vaults.getRetirementState(userId);
      if (!retirement) return { status: 'not_found' };
      if (retirement.retiredVersion !== input.retiredVersion) return { status: 'state_conflict' };
      if (
        !verifyRetiredChallenge(
          deps.proofSecret,
          input.challenge,
          userId,
          input.retiredVersion,
          now().getTime(),
        ) ||
        !verifyRetiredSignature(retirement.retirementProofPublicKey, input)
      ) {
        return { status: 'proof_invalid' };
      }
      return deps.vaults.purgeRetired({
        userId,
        retiredVersion: input.retiredVersion,
        proofVerified: true,
        now: now(),
      });
    },
  };
}

function inspectBlob(
  blob: Buffer,
  maxBytes: number,
):
  | { header: { formatVersion: number; vaultVersion: number } }
  | { status: 'too_large'; sizeBytes: number; maxBytes: number }
  | { status: 'malformed'; reason: string } {
  if (blob.length > maxBytes) return { status: 'too_large', sizeBytes: blob.length, maxBytes };
  try {
    return { header: readVaultServerHeader(blob) };
  } catch (err) {
    if (err instanceof VaultEnvelopeError) return { status: 'malformed', reason: err.message };
    throw err;
  }
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
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { purpose?: unknown }).purpose !== purpose
    ) {
      return null;
    }
    return parsed as OpaqueTokenPayload;
  } catch {
    return null;
  }
}

function verifyCandidateReadback(
  secret: string | undefined,
  token: string,
  userId: string,
  candidateId: string,
  nowMs: number,
): boolean {
  const payload = verifyOpaqueToken(secret, 'candidate-readback', token);
  return (
    payload?.userId === userId &&
    payload.candidateId === candidateId &&
    typeof payload.version === 'number' &&
    typeof payload.expiresAt === 'number' &&
    payload.expiresAt > nowMs
  );
}

function verifyRetiredChallenge(
  secret: string | undefined,
  challenge: string,
  userId: string,
  retiredVersion: number,
  nowMs: number,
): boolean {
  const payload = verifyOpaqueToken(secret, 'retired-server-purge', challenge);
  return (
    payload?.userId === userId &&
    payload.retiredVersion === retiredVersion &&
    typeof payload.expiresAt === 'number' &&
    payload.expiresAt > nowMs &&
    typeof payload.nonce === 'string'
  );
}

function verifyRetiredSignature(publicKey: string, input: RetiredServerPurgeRequest): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verifySignature(
      null,
      Buffer.from(
        serializeRetiredServerPurgeTranscript({
          retiredVersion: input.retiredVersion,
          observedVersion: input.observedVersion,
          challenge: input.challenge,
        }),
      ),
      key,
      Buffer.from(input.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
