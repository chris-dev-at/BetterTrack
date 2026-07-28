import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  serializeRetiredServerPurgeTranscript,
  vaultClientSecuritySchema,
  type VaultDocumentV1,
} from '@bettertrack/contracts';

import { mergeVaultDocuments } from '../merge';
import { createVaultRetirementProofManager } from './retirementProof';

const document: VaultDocumentV1 = {
  schemaVersion: 1,
  entities: {},
  mergeLog: [],
};
const subtle = webcrypto.subtle as unknown as SubtleCrypto;

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('client-held retirement proof material', () => {
  it('provisions one encrypted Ed25519 pair and signs the server transcript', async () => {
    const manager = createVaultRetirementProofManager(subtle);
    const ensured = await manager.ensure(document);
    expect(ensured.changed).toBe(true);
    const security = vaultClientSecuritySchema.parse(ensured.document.clientSecurity);
    expect(manager.publicKey).toBe(security.retirementProof.publicKey);

    const input = {
      retiredVersion: 4,
      observedVersion: 6,
      challenge: 'challenge'.repeat(5),
    };
    const signature = await manager.sign(input);
    const publicKey = await webcrypto.subtle.importKey(
      'spki',
      fromBase64url(security.retirementProof.publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    await expect(
      webcrypto.subtle.verify(
        'Ed25519',
        publicKey,
        fromBase64url(signature),
        serializeRetiredServerPurgeTranscript(input),
      ),
    ).resolves.toBe(true);

    const restored = createVaultRetirementProofManager(subtle);
    await expect(restored.ensure(ensured.document)).resolves.toMatchObject({ changed: false });
    expect(restored.publicKey).toBe(manager.publicKey);
  });

  it('preserves one proof pair through merges and fails closed on divergent pairs', async () => {
    const first = createVaultRetirementProofManager(subtle);
    const second = createVaultRetirementProofManager(subtle);
    const secured = (await first.ensure(document)).document;
    const other = (await second.ensure(document)).document;

    expect(
      mergeVaultDocuments({
        left: secured,
        leftVersion: 2,
        right: document,
        rightVersion: 1,
        deviceId: '018f0000-0000-7000-8000-00000000000a',
        mergedAt: '2026-07-28T10:00:00.000Z',
      }).document.clientSecurity,
    ).toEqual(secured.clientSecurity);

    expect(() =>
      mergeVaultDocuments({
        left: secured,
        leftVersion: 2,
        right: other,
        rightVersion: 2,
        deviceId: '018f0000-0000-7000-8000-00000000000a',
        mergedAt: '2026-07-28T10:00:00.000Z',
      }),
    ).toThrow(/proof material diverged/i);
  });
});

function fromBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (character) =>
    character.charCodeAt(0),
  );
}
