import { createPrivateKey, sign } from 'node:crypto';

import { serializePortfolioVaultMoveOutProofTranscript } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import {
  issuePortfolioVaultMoveOutChallenge,
  portfolioVaultRestoreDocumentDigest,
  verifyPortfolioVaultMoveOutChallenge,
  verifyPortfolioVaultMoveOutPhraseProof,
} from '../portfolioVaultPhraseProof';

// RFC 8032 Ed25519 TEST VECTOR 1. Public standard material, never a secret.
const TEST_VECTOR_SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
);
const TEST_VECTOR_PUBLIC = Buffer.from(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  'hex',
);
const TEST_VECTOR_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), TEST_VECTOR_SEED]),
  format: 'der',
  type: 'pkcs8',
});
const TEST_VECTOR_PUBLIC_KEY = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  TEST_VECTOR_PUBLIC,
]).toString('base64url');
const TEST_VECTOR_OTHER_PUBLIC_KEY = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.concat([
    TEST_VECTOR_PUBLIC.subarray(0, -1),
    Buffer.from([TEST_VECTOR_PUBLIC.at(-1)! ^ 1]),
  ]),
]).toString('base64url');
const PORTFOLIO_ID = '018f6a3e-2222-7000-8000-000000000001';
const VAULT_ID = '018f6a3e-1111-7000-8000-000000000001';
const USER_ID = '018f6a3e-3333-7000-8000-000000000001';
const OTHER_ID = '018f6a3e-4444-7000-8000-000000000001';
const CHALLENGE_SECRET = 'TEST VECTOR server challenge authentication secret';
const CHALLENGE_NOW = new Date('2026-08-21T10:00:00.000Z');
const CHALLENGE_NONCE = 'TEST_VECTOR_deterministic_nonce_32';
const DOCUMENT_SET_HASH = 'S'.repeat(43);
const document = { schemaVersion: 1, entities: [], mergeLog: [], mirrorProvenance: [] };

function mutateSignificantBase64urlCharacter(value: string): string {
  return `${value.startsWith('A') ? 'B' : 'A'}${value.slice(1)}`;
}

function proof(
  overrides: { documentDigest?: string; documentSetHash?: string; challenge?: string } = {},
) {
  const documentDigest = overrides.documentDigest ?? portfolioVaultRestoreDocumentDigest(document);
  const documentSetHash = overrides.documentSetHash ?? DOCUMENT_SET_HASH;
  const challenge = overrides.challenge ?? 'TEST VECTOR challenge'.padEnd(32, '.');
  return {
    challenge,
    signature: sign(
      null,
      Buffer.from(
        serializePortfolioVaultMoveOutProofTranscript({
          portfolioId: PORTFOLIO_ID,
          vaultId: VAULT_ID,
          lifecycleGeneration: 4,
          documentDigest,
          documentSetHash,
          challenge,
        }),
      ),
      TEST_VECTOR_PRIVATE_KEY,
    ).toString('base64url'),
  };
}

describe('portfolio vault move-out phrase proof', () => {
  it('accepts a server-authenticated challenge for exactly its bound tuple before expiry', () => {
    const documentDigest = portfolioVaultRestoreDocumentDigest(document);
    const issued = issuePortfolioVaultMoveOutChallenge({
      secret: CHALLENGE_SECRET,
      userId: USER_ID,
      portfolioId: PORTFOLIO_ID,
      vaultId: VAULT_ID,
      lifecycleGeneration: 4,
      documentDigest,
      documentSetHash: DOCUMENT_SET_HASH,
      now: CHALLENGE_NOW,
      nonce: CHALLENGE_NONCE,
    });

    expect(issued).toMatchObject({
      portfolioId: PORTFOLIO_ID,
      vaultId: VAULT_ID,
      lifecycleGeneration: 4,
      documentDigest,
      documentSetHash: DOCUMENT_SET_HASH,
      expiresAt: '2026-08-21T10:05:00.000Z',
    });
    expect(
      verifyPortfolioVaultMoveOutChallenge({
        secret: CHALLENGE_SECRET,
        challenge: issued.challenge,
        userId: USER_ID,
        portfolioId: PORTFOLIO_ID,
        vaultId: VAULT_ID,
        lifecycleGeneration: 4,
        documentDigest,
        documentSetHash: DOCUMENT_SET_HASH,
        now: new Date('2026-08-21T10:04:59.999Z'),
      }),
    ).toBe(true);
  });

  it.each([
    ['secret', { secret: 'TEST VECTOR different server secret' }],
    ['user', { userId: OTHER_ID }],
    ['portfolio', { portfolioId: OTHER_ID }],
    ['vault', { vaultId: OTHER_ID }],
    ['lifecycle', { lifecycleGeneration: 5 }],
    ['document digest', { documentDigest: 'A'.repeat(43) }],
    ['document set hash', { documentSetHash: 'A'.repeat(43) }],
    ['expiry boundary', { now: new Date('2026-08-21T10:05:00.000Z') }],
    ['post-expiry time', { now: new Date('2026-08-21T10:05:00.001Z') }],
  ])('rejects a challenge replay against a changed %s', (_label, changed) => {
    const documentDigest = portfolioVaultRestoreDocumentDigest(document);
    const { challenge } = issuePortfolioVaultMoveOutChallenge({
      secret: CHALLENGE_SECRET,
      userId: USER_ID,
      portfolioId: PORTFOLIO_ID,
      vaultId: VAULT_ID,
      lifecycleGeneration: 4,
      documentDigest,
      documentSetHash: DOCUMENT_SET_HASH,
      now: CHALLENGE_NOW,
      nonce: CHALLENGE_NONCE,
    });

    expect(
      verifyPortfolioVaultMoveOutChallenge({
        secret: CHALLENGE_SECRET,
        challenge,
        userId: USER_ID,
        portfolioId: PORTFOLIO_ID,
        vaultId: VAULT_ID,
        lifecycleGeneration: 4,
        documentDigest,
        documentSetHash: DOCUMENT_SET_HASH,
        now: CHALLENGE_NOW,
        ...changed,
      }),
    ).toBe(false);
  });

  it.each([
    [
      'payload byte',
      (challenge: string) =>
        `${challenge.slice(0, 5)}${challenge[5] === 'A' ? 'B' : 'A'}${challenge.slice(6)}`,
    ],
    [
      'MAC byte',
      (challenge: string) => `${challenge.slice(0, -1)}${challenge.endsWith('A') ? 'B' : 'A'}`,
    ],
    ['missing MAC', (challenge: string) => challenge.split('.')[0]!],
    ['extra segment', (challenge: string) => `${challenge}.extra`],
    ['non-token text', () => 'x'.repeat(32)],
  ])('rejects a challenge with a tampered or malformed %s', (_label, mutate) => {
    const documentDigest = portfolioVaultRestoreDocumentDigest(document);
    const { challenge } = issuePortfolioVaultMoveOutChallenge({
      secret: CHALLENGE_SECRET,
      userId: USER_ID,
      portfolioId: PORTFOLIO_ID,
      vaultId: VAULT_ID,
      lifecycleGeneration: 4,
      documentDigest,
      documentSetHash: DOCUMENT_SET_HASH,
      now: CHALLENGE_NOW,
      nonce: CHALLENGE_NONCE,
    });

    expect(
      verifyPortfolioVaultMoveOutChallenge({
        secret: CHALLENGE_SECRET,
        challenge: mutate(challenge),
        userId: USER_ID,
        portfolioId: PORTFOLIO_ID,
        vaultId: VAULT_ID,
        lifecycleGeneration: 4,
        documentDigest,
        documentSetHash: DOCUMENT_SET_HASH,
        now: CHALLENGE_NOW,
      }),
    ).toBe(false);
  });

  it('accepts the deterministic phrase-held signature and canonical object-key order', () => {
    const phraseProof = proof();
    expect(
      verifyPortfolioVaultMoveOutPhraseProof({
        retirementProofPublicKey: TEST_VECTOR_PUBLIC_KEY,
        portfolioId: PORTFOLIO_ID,
        vaultId: VAULT_ID,
        lifecycleGeneration: 4,
        documentSetHash: DOCUMENT_SET_HASH,
        document: { mirrorProvenance: [], entities: [], schemaVersion: 1, mergeLog: [] },
        vaultProof: phraseProof,
      }),
    ).toBe(true);
  });

  it.each([
    [
      'different valid public key',
      {
        retirementProofPublicKey: TEST_VECTOR_OTHER_PUBLIC_KEY,
      },
    ],
    ['malformed public key', { retirementProofPublicKey: 'not-a-der-key' }],
    [
      'mutated signature',
      {
        vaultProof: (() => {
          const signed = proof();
          return {
            ...signed,
            // Avoid the unused padding bits in the final base64url character:
            // changing those bits can still decode to the original signature.
            signature: mutateSignificantBase64urlCharacter(signed.signature),
          };
        })(),
      },
    ],
  ])('rejects a proof with a %s', (_label, changed) => {
    expect(
      verifyPortfolioVaultMoveOutPhraseProof({
        retirementProofPublicKey: TEST_VECTOR_PUBLIC_KEY,
        portfolioId: PORTFOLIO_ID,
        vaultId: VAULT_ID,
        lifecycleGeneration: 4,
        documentSetHash: DOCUMENT_SET_HASH,
        document,
        vaultProof: proof(),
        ...changed,
      }),
    ).toBe(false);
  });

  it.each([
    ['document', { document: { ...document, mergeLog: [{ changed: true }] } }],
    ['vault', { vaultId: PORTFOLIO_ID }],
    ['portfolio', { portfolioId: VAULT_ID }],
    ['lifecycle', { lifecycleGeneration: 5 }],
    ['document set', { documentSetHash: 'A'.repeat(43) }],
    [
      'challenge',
      {
        vaultProof: {
          ...proof(),
          challenge: 'changed challenge'.padEnd(32, '.'),
        },
      },
    ],
    ['claimed digest', { vaultProof: proof({ documentDigest: 'A'.repeat(43) }) }],
  ])('rejects a signature replay against a changed %s', (_label, changed) => {
    expect(
      verifyPortfolioVaultMoveOutPhraseProof({
        retirementProofPublicKey: TEST_VECTOR_PUBLIC_KEY,
        portfolioId: PORTFOLIO_ID,
        vaultId: VAULT_ID,
        lifecycleGeneration: 4,
        documentSetHash: DOCUMENT_SET_HASH,
        document,
        vaultProof: proof(),
        ...changed,
      }),
    ).toBe(false);
  });
});
