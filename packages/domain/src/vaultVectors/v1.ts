import fixture from './v1.fixture.json';

/**
 * BTVAULT1 (v1) conformance vectors — the account-singleton vault format.
 *
 * RELOCATED from `apps/web/src/user/vault/vectors.ts` (design r3 / mobile N2):
 * `packages/domain` is the shared vectors location both clients pin, so the
 * mobile port never again has to vendor crypto oracles out of the web APP.
 * The fixture bytes are UNCHANGED by the move — that is the whole point of a
 * conformance vector — and the web replay suites now import them from here.
 *
 * Like every module in this package it imports NOTHING (design r3 build
 * ruling): even a type-only import of `@bettertrack/contracts` would pull the
 * contracts sources into this package's compile graph, and contracts uses
 * platform globals (`TextEncoder`, `URL`) that this package's deliberately
 * minimal lib config does not provide — the isomorphic-purity guarantee is a
 * BUILD property, not just a runtime one. The `VaultVector*` interfaces below
 * are therefore local STRUCTURAL mirrors of the contract shapes; the web
 * replay suite parses every fixture through the real zod schemas, so a drift
 * between mirror and contract fails the build there, where both sides exist.
 */

export const VECTOR_KEY_ID = '018f0000-0000-7000-8000-00000000000a';
export const VECTOR_DEVICE_ID = '018f0000-0000-7000-8000-00000000000b';
export const VECTOR_WRITE_ID = '018f0000-0000-7000-8000-00000000000c';
export const VECTOR_NEXT_KEY_ID = '018f0000-0000-7000-8000-00000000000d';

// ── Structural mirrors of the v1 contract shapes (see the header note) ───────

/** Mirror of `VaultKdfParams` (`vaultKdfParamsSchema`). */
export interface VaultVectorKdfParams {
  alg: 'argon2id';
  m: number;
  t: number;
  p: number;
  salt: string;
}

/** Mirror of `VaultWrappedKey` (`vaultWrappedKeySchema`). */
export interface VaultVectorWrappedKey {
  keyId: string;
  kdf: VaultVectorKdfParams;
  wrappedVk: string;
}

/** Mirror of `VaultEnvelopeHeader` (`vaultEnvelopeHeaderSchema`). */
export interface VaultVectorEnvelopeHeader {
  formatVersion: number;
  cipher: 'A256GCM';
  iv: string;
  keyId: string;
  wrappedKeys: VaultVectorWrappedKey[];
  vaultVersion: number;
  schemaVersion: number;
  deviceId: string;
  writeId: string;
  writtenAt: string;
}

/** Mirror of `VaultEntity` (`vaultEntitySchema`). */
export interface VaultVectorEntity {
  id: string;
  rev: number;
  editedAt: string;
  editedBy: string;
  deletedAt: string | null;
  data: Record<string, unknown>;
}

/** Mirror of `VaultMergeRecord` (`vaultMergeRecordSchema`). */
export interface VaultVectorMergeRecord {
  mergedAt: string;
  parents: number[];
  into: number;
  deviceId: string;
}

/** Mirror of the schemaVersion-1 `VaultDocument` (`vaultDocumentV1Schema`). */
export interface VaultVectorDocument {
  schemaVersion: 1;
  entities: Record<string, VaultVectorEntity[]>;
  mergeLog: VaultVectorMergeRecord[];
}

export const vaultVectorDocument: VaultVectorDocument = {
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
  // Deliberately no `mirrorProvenance`: this is the published pre-§7.1 document,
  // and an absent key keeps its plaintext — and therefore these fixed envelope
  // bytes — byte-identical through decrypt/re-encrypt.
};

export interface VaultInteroperabilityFixture {
  passphrase: string;
  newPassphrase: string;
  vaultKeyBase64: string;
  kdf: VaultVectorKdfParams;
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
  header: VaultVectorEnvelopeHeader;
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

/** The deterministic byte source every vector in this package is generated with. */
export type VectorRandomBytes = (length: number) => Uint8Array;

/** Deterministic only for reproducing public test vectors — never use for real vaults. */
export function deterministicRandom(start = 0): VectorRandomBytes {
  let next = start;
  return (length) => Uint8Array.from({ length }, () => next++ & 0xff);
}
