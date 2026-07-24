import type { VaultDocumentV1, VaultEnvelopeHeader, VaultKdfParams } from '@bettertrack/contracts';

import fixture from './vectors.fixture.json';

import type { RandomBytes } from './crypto';

export const VECTOR_KEY_ID = '018f0000-0000-7000-8000-00000000000a';
export const VECTOR_DEVICE_ID = '018f0000-0000-7000-8000-00000000000b';
export const VECTOR_WRITE_ID = '018f0000-0000-7000-8000-00000000000c';
export const VECTOR_NEXT_KEY_ID = '018f0000-0000-7000-8000-00000000000d';

export const vaultVectorDocument: VaultDocumentV1 = {
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
  passphraseChanged: VaultFixtureEnvelope;
  rotated: VaultFixtureEnvelope & { keyId: string };
  recoveryKitBase64: string;
  rollback: {
    priorVaultVersion: number;
    rejectedVaultVersion: number;
    nextVaultVersion: number;
    passphraseChangeFailAtRandomCall: number;
    rotationFailAtRandomCall: number;
    expectedEnvelopeBase64: string;
  };
}

interface VaultFixtureEnvelope {
  header: VaultEnvelopeHeader;
  headerBytesBase64: string;
  envelopeBase64: string;
  tamperedEnvelopeBase64?: string;
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
