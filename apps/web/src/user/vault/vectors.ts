import type { VaultDocument, VaultEnvelopeHeader, VaultKdfParams } from '@bettertrack/contracts';

import fixture from './vectors.fixture.json';

import type { RandomBytes } from './crypto';

export const VECTOR_KEY_ID = '018f0000-0000-7000-8000-00000000000a';
export const VECTOR_DEVICE_ID = '018f0000-0000-7000-8000-00000000000b';
export const VECTOR_WRITE_ID = '018f0000-0000-7000-8000-00000000000c';
export const VECTOR_NEXT_KEY_ID = '018f0000-0000-7000-8000-00000000000d';

export const vaultVectorDocument: VaultDocument = {
  schemaVersion: 1,
  entities: {
    portfolio: [
      {
        id: VECTOR_KEY_ID,
        rev: 1,
        editedAt: '2026-07-24T10:00:00.000Z',
        editedBy: VECTOR_DEVICE_ID,
        deletedAt: null,
        data: { name: 'Vector portfolio' },
      },
    ],
  },
  mergeLog: [],
};

export interface VaultInteroperabilityFixture {
  passphrase: string;
  newPassphrase: string;
  vaultKeyBase64: string;
  kdf: VaultKdfParams;
  kekBase64: string;
  initial: VaultFixtureEnvelope;
  wrongSecret: {
    passphrase: string;
    kekBase64: string;
    expectedErrorCode: 'authentication-failed';
  };
  updateRequired: {
    formatVersion: number;
    schemaVersion: number;
    headerBytesBase64: string;
    envelopeBase64: string;
    expectedStatus: 'update-required';
  };
  passphraseChanged: VaultFixtureEnvelope;
  rotated: VaultFixtureEnvelope & { keyId: string };
  recoveryKitBase64: string;
  rollback: {
    priorVaultVersion: number;
    rejectedVaultVersion: number;
    nextVaultVersion: number;
    expectedEnvelopeBase64: string;
    expectedHeaderBytesBase64: string;
    expectedVaultKeyBase64: string;
    expectedKeyId: string;
    passphraseChange: VaultRollbackCase;
    rotation: VaultRollbackCase & { keyId: string };
  };
}

interface VaultFixtureEnvelope {
  header: VaultEnvelopeHeader;
  headerBytesBase64: string;
  envelopeBase64: string;
  tamperedEnvelopeBase64?: string;
}

interface VaultRollbackCase {
  randomStart: number;
  failAtRandomCall: number;
  oldPassphrase: string;
  newPassphrase?: string;
  metadata: {
    vaultVersion: number;
    deviceId: string;
    writeId: string;
    writtenAt: string;
  };
  expectedErrorMessage: string;
}

/**
 * Public fixed interoperability fixtures. They are produced with the production
 * hash-wasm Argon2id path (m=65536, t=3, p=1), deterministic random input, and
 * native AES-256-GCM. Consumers can reproduce the exact serialized bytes.
 */
export const vaultInteroperabilityFixture = fixture as VaultInteroperabilityFixture;

/** Deterministic only for reproducing public test vectors — never use for real vaults. */
export function deterministicRandom(start = 0): RandomBytes {
  let next = start;
  return (length) => Uint8Array.from({ length }, () => next++ & 0xff);
}
