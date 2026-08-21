import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

import {
  PORTFOLIO_VAULT_MOVE_OUT_CHALLENGE_TTL_MS,
  portfolioVaultMoveOutChallengeResponseSchema,
  serializePortfolioVaultMoveOutProofTranscript,
  serializePortfolioVaultRestoreDocument,
  type PortfolioVaultMoveOutChallengeResponse,
  type PortfolioVaultMoveOutProof,
} from '@bettertrack/contracts';

/** Canonical restore identity shared by idempotency and phrase possession. */
export function portfolioVaultRestoreDocumentDigest(document: unknown): string {
  return createHash('sha256')
    .update(serializePortfolioVaultRestoreDocument(document))
    .digest('base64url');
}

const MOVE_OUT_CHALLENGE_PURPOSE = 'portfolio-vault-move-out';

interface MoveOutChallengeClaims {
  purpose: typeof MOVE_OUT_CHALLENGE_PURPOSE;
  userId: string;
  portfolioId: string;
  vaultId: string;
  lifecycleGeneration: number;
  documentDigest: string;
  documentSetHash: string;
  expiresAt: number;
  nonce: string;
}

function signChallenge(secret: string, claims: Omit<MoveOutChallengeClaims, 'purpose'>): string {
  const encoded = Buffer.from(
    JSON.stringify({ purpose: MOVE_OUT_CHALLENGE_PURPOSE, ...claims }),
  ).toString('base64url');
  const mac = createHmac('sha256', secret)
    .update(`${MOVE_OUT_CHALLENGE_PURPOSE}.${encoded}`)
    .digest('base64url');
  return `${encoded}.${mac}`;
}

function readChallenge(secret: string, token: string): MoveOutChallengeClaims | null {
  const [encoded, suppliedMac, extra] = token.split('.');
  if (!encoded || !suppliedMac || extra !== undefined) return null;
  const expectedMac = createHmac('sha256', secret)
    .update(`${MOVE_OUT_CHALLENGE_PURPOSE}.${encoded}`)
    .digest('base64url');
  const expected = Buffer.from(expectedMac);
  const supplied = Buffer.from(suppliedMac);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { purpose?: unknown }).purpose !== MOVE_OUT_CHALLENGE_PURPOSE
    ) {
      return null;
    }
    return parsed as MoveOutChallengeClaims;
  } catch {
    return null;
  }
}

export function issuePortfolioVaultMoveOutChallenge(input: {
  secret: string;
  userId: string;
  portfolioId: string;
  vaultId: string;
  lifecycleGeneration: number;
  documentDigest: string;
  documentSetHash: string;
  now: Date;
  /** Deterministic TEST VECTOR seam; production always uses random bytes. */
  nonce?: string;
}): PortfolioVaultMoveOutChallengeResponse {
  const expiresAt = new Date(input.now.getTime() + PORTFOLIO_VAULT_MOVE_OUT_CHALLENGE_TTL_MS);
  return portfolioVaultMoveOutChallengeResponseSchema.parse({
    portfolioId: input.portfolioId,
    vaultId: input.vaultId,
    lifecycleGeneration: input.lifecycleGeneration,
    documentDigest: input.documentDigest,
    documentSetHash: input.documentSetHash,
    challenge: signChallenge(input.secret, {
      userId: input.userId,
      portfolioId: input.portfolioId,
      vaultId: input.vaultId,
      lifecycleGeneration: input.lifecycleGeneration,
      documentDigest: input.documentDigest,
      documentSetHash: input.documentSetHash,
      expiresAt: expiresAt.getTime(),
      nonce: input.nonce ?? randomBytes(24).toString('base64url'),
    }),
    expiresAt: expiresAt.toISOString(),
  });
}

export function verifyPortfolioVaultMoveOutChallenge(input: {
  secret: string;
  challenge: string;
  userId: string;
  portfolioId: string;
  vaultId: string;
  lifecycleGeneration: number;
  documentDigest: string;
  documentSetHash: string;
  now: Date;
}): boolean {
  const claims = readChallenge(input.secret, input.challenge);
  return Boolean(
    claims &&
    claims.userId === input.userId &&
    claims.portfolioId === input.portfolioId &&
    claims.vaultId === input.vaultId &&
    claims.lifecycleGeneration === input.lifecycleGeneration &&
    claims.documentDigest === input.documentDigest &&
    claims.documentSetHash === input.documentSetHash &&
    typeof claims.expiresAt === 'number' &&
    claims.expiresAt > input.now.getTime() &&
    typeof claims.nonce === 'string' &&
    claims.nonce.length >= 32,
  );
}

/**
 * Prove the cleartext graph came from a client that opened the encrypted
 * common doc. The matching private key exists only in that doc; the immutable
 * public verifier is registered with the vault at creation.
 */
export function verifyPortfolioVaultMoveOutPhraseProof(input: {
  retirementProofPublicKey: string;
  portfolioId: string;
  vaultId: string;
  lifecycleGeneration: number;
  documentSetHash: string;
  document: unknown;
  vaultProof: PortfolioVaultMoveOutProof;
}): boolean {
  const documentDigest = portfolioVaultRestoreDocumentDigest(input.document);
  try {
    const key = createPublicKey({
      key: Buffer.from(input.retirementProofPublicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return (
      key.asymmetricKeyType === 'ed25519' &&
      verifySignature(
        null,
        Buffer.from(
          serializePortfolioVaultMoveOutProofTranscript({
            portfolioId: input.portfolioId,
            vaultId: input.vaultId,
            lifecycleGeneration: input.lifecycleGeneration,
            documentDigest,
            documentSetHash: input.documentSetHash,
            challenge: input.vaultProof.challenge,
          }),
        ),
        key,
        Buffer.from(input.vaultProof.signature, 'base64url'),
      )
    );
  } catch {
    return false;
  }
}
