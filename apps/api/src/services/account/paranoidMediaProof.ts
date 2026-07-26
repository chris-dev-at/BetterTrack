import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  prepareParanoidMediaVerificationRequestSchema,
  type PrepareParanoidMediaVerificationRequest,
} from '@bettertrack/contracts';

const PROOF_VERSION = 1;
const PROOF_DOMAIN = 'bettertrack:paranoid-media-proof:v1:';

export const PARANOID_MEDIA_PROOF_TTL_MS = 2 * 60 * 1000;

export interface ParanoidMediaProofPayload extends PrepareParanoidMediaVerificationRequest {
  userId: string;
  /** Internal monotonic account-media generation observed while minting. */
  generation: number;
  expiresAtMs: number;
}

/**
 * Sign one exact media transition. The payload contains only account/media
 * metadata and expires quickly; Drive tokens, file ids and ciphertext never
 * enter it.
 */
export function signParanoidMediaProof(secret: string, payload: ParanoidMediaProofPayload): string {
  const body = Buffer.from(
    JSON.stringify({
      v: PROOF_VERSION,
      userId: payload.userId,
      generation: payload.generation,
      expected: payload.expected,
      nextMediaSet: payload.nextMediaSet,
      verification: payload.verification,
      expiresAtMs: payload.expiresAtMs,
    }),
    'utf8',
  ).toString('base64url');
  return `${body}.${signature(secret, body)}`;
}

/** Verify signature, shape and expiry without ever throwing on caller input. */
export function verifyParanoidMediaProof(
  secret: string,
  proof: string,
  nowMs: number,
): ParanoidMediaProofPayload | null {
  const [body, suppliedSignature, extra] = proof.split('.');
  if (!body || !suppliedSignature || extra !== undefined) return null;
  const expectedSignature = signature(secret, body);
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      v?: unknown;
      userId?: unknown;
      generation?: unknown;
      expected?: unknown;
      nextMediaSet?: unknown;
      verification?: unknown;
      expiresAtMs?: unknown;
    };
    if (
      decoded.v !== PROOF_VERSION ||
      typeof decoded.userId !== 'string' ||
      decoded.userId.length === 0 ||
      !Number.isSafeInteger(decoded.generation) ||
      (decoded.generation as number) < 0 ||
      !Number.isSafeInteger(decoded.expiresAtMs) ||
      (decoded.expiresAtMs as number) <= nowMs
    ) {
      return null;
    }
    const request = prepareParanoidMediaVerificationRequestSchema.safeParse({
      expected: decoded.expected,
      nextMediaSet: decoded.nextMediaSet,
      verification: decoded.verification,
    });
    if (!request.success) return null;
    return {
      userId: decoded.userId,
      generation: decoded.generation as number,
      ...request.data,
      expiresAtMs: decoded.expiresAtMs as number,
    };
  } catch {
    return null;
  }
}

export function proofMatchesRequest(
  payload: ParanoidMediaProofPayload,
  userId: string,
  request: PrepareParanoidMediaVerificationRequest,
): boolean {
  return (
    payload.userId === userId &&
    sameState(payload.expected, request.expected) &&
    sameSet(payload.nextMediaSet, request.nextMediaSet) &&
    payload.verification.medium === request.verification.medium &&
    payload.verification.version === request.verification.version &&
    payload.verification.serverCandidateId === request.verification.serverCandidateId
  );
}

function signature(secret: string, body: string): string {
  return createHmac('sha256', `${PROOF_DOMAIN}${secret}`).update(body).digest('base64url');
}

function sameState(
  left: PrepareParanoidMediaVerificationRequest['expected'],
  right: PrepareParanoidMediaVerificationRequest['expected'],
): boolean {
  return (
    sameSet(left.mediaSet, right.mediaSet) &&
    left.driveAttestedVersion === right.driveAttestedVersion
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((medium) => right.includes(medium)) &&
    right.every((medium) => left.includes(medium))
  );
}
