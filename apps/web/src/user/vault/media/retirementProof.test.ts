import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  serializeRetiredServerPurgeTranscript,
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_DOCUMENT_VERSION,
  vaultClientSecuritySchema,
  vaultDocumentV1Schema,
  type VaultDocument,
  type VaultEnvelopeHeader,
} from '@bettertrack/contracts';

import { base64ToBytes } from '../bytes';
import { decryptVaultDocument, encryptVaultDocument } from '../crypto';
import { decodeVaultEnvelope } from '../envelope';
import { mergeVaultDocuments } from '../merge';
import fixture from '../vectors.fixture.json';
import { createVaultRetirementProofManager } from './retirementProof';

const document: VaultDocument = {
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
    const security = securityOf(ensured.document);
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

  it('upgrades the authenticated payload version before a v1 writer can erase the key', async () => {
    const manager = createVaultRetirementProofManager(subtle);
    const ensured = await manager.ensure(document);
    const fixtureHeader = fixture.initial.header as VaultEnvelopeHeader;
    const vaultKey = base64ToBytes(fixture.vaultKeyBase64, 'envelope-invalid');
    const encrypted = await encryptVaultDocument({
      document: ensured.document,
      vaultKey,
      header: {
        keyId: fixtureHeader.keyId,
        wrappedKeys: fixtureHeader.wrappedKeys,
        vaultVersion: 2,
        deviceId: fixtureHeader.deviceId,
        writeId: '018f0000-0000-7000-8000-0000000000d2',
        writtenAt: '2026-07-28T10:00:00.000Z',
      },
    });

    expect(encrypted.header.schemaVersion).toBe(VAULT_DOCUMENT_VERSION);
    await expect(legacyWriterRoundTrip(encrypted.envelope, vaultKey)).rejects.toThrow(
      /newer vault schema/i,
    );
    expect(vaultDocumentV1Schema.safeParse(ensured.document).success).toBe(false);

    const restored = await decryptVaultDocument(encrypted.envelope, vaultKey);
    expect(securityOf(restored.document)).toEqual(securityOf(ensured.document));
  });

  it('preserves one proof pair through merges and fails closed on divergent pairs', async () => {
    const first = createVaultRetirementProofManager(subtle);
    const second = createVaultRetirementProofManager(subtle);
    const secured = (await first.ensure(document)).document;
    const other = (await second.ensure(document)).document;

    expect(
      securityOf(
        mergeVaultDocuments({
          left: secured,
          leftVersion: 2,
          right: document,
          rightVersion: 1,
          deviceId: '018f0000-0000-7000-8000-00000000000a',
          mergedAt: '2026-07-28T10:00:00.000Z',
        }).document,
      ),
    ).toEqual(securityOf(secured));

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

function securityOf(document: VaultDocument) {
  expect(document.schemaVersion).toBe(VAULT_DOCUMENT_VERSION);
  if (document.schemaVersion !== VAULT_DOCUMENT_VERSION) {
    throw new Error('expected a secured v2 vault document');
  }
  return vaultClientSecuritySchema.parse(document.clientSecurity);
}

async function legacyWriterRoundTrip(
  envelope: Uint8Array,
  vaultKey: Uint8Array,
): Promise<Uint8Array> {
  const { header } = decodeVaultEnvelope(envelope);
  if (header.schemaVersion > VAULT_DOCUMENT_V1_VERSION) {
    throw new Error('A v1 writer cannot open a newer vault schema.');
  }
  const decrypted = await decryptVaultDocument(envelope, vaultKey);
  const legacyDocument = vaultDocumentV1Schema.parse(decrypted.document);
  return (
    await encryptVaultDocument({
      document: legacyDocument,
      vaultKey,
      header: {
        keyId: header.keyId,
        wrappedKeys: header.wrappedKeys,
        vaultVersion: header.vaultVersion + 1,
        deviceId: header.deviceId,
        writeId: '018f0000-0000-7000-8000-0000000000d3',
        writtenAt: '2026-07-28T10:01:00.000Z',
      },
    })
  ).envelope;
}

function fromBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (character) =>
    character.charCodeAt(0),
  );
}
