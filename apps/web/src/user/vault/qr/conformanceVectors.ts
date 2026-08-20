import type { VaultTransferPayload, VaultTransferPayloadErrorOutcome } from './payload';

/** Public BIP39 test vector (128 zero entropy bits), never production key material. */
export const VAULT_TRANSFER_VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const VAULT_TRANSFER_VECTOR_VAULT_ID = '018f6a3e-1111-7000-8000-000000000001';
export const VAULT_TRANSFER_VECTOR_NAME = 'Phone vault';
export const VAULT_TRANSFER_VECTOR_FINGERPRINT = 'AbCdEfGhIjKlMn_o';

/** Binding serializer golden shared with the mobile scanner implementation. */
export const VAULT_TRANSFER_GOLDEN_PAYLOAD =
  'btvault1:m=abandon+abandon+abandon+abandon+abandon+abandon+abandon+abandon+abandon+abandon+abandon+about&v=018f6a3e-1111-7000-8000-000000000001&n=Phone+vault&f=AbCdEfGhIjKlMn_o';

export interface VaultTransferValidConformanceVector {
  payload: string;
  expected: VaultTransferPayload;
}

export interface VaultTransferRejectedConformanceVector {
  payload: string;
  outcome: VaultTransferPayloadErrorOutcome;
}

const EXPECTED: VaultTransferPayload = {
  mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
  vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
  name: VAULT_TRANSFER_VECTOR_NAME,
  fingerprint: VAULT_TRANSFER_VECTOR_FINGERPRINT,
};

/**
 * JSON-shaped cross-client fixture. Mobile tests consume these exact strings;
 * changing one is a wire-format change, not a harmless web refactor.
 */
export const VAULT_TRANSFER_CONFORMANCE_VECTORS = {
  validRoundTrip: {
    payload: VAULT_TRANSFER_GOLDEN_PAYLOAD,
    expected: EXPECTED,
  },
  unknownPrefix: {
    payload: VAULT_TRANSFER_GOLDEN_PAYLOAD.replace('btvault1:', 'btvault2:'),
    outcome: 'update-required',
  },
  bareString: {
    payload: VAULT_TRANSFER_GOLDEN_PAYLOAD.slice('btvault1:'.length),
    outcome: 'update-required',
  },
  missingMnemonic: {
    payload: `btvault1:v=${VAULT_TRANSFER_VECTOR_VAULT_ID}`,
    outcome: 'missing-mnemonic',
  },
  missingVaultId: {
    payload:
      'btvault1:m=abandon+abandon+abandon+abandon+abandon+abandon+abandon+abandon+abandon+abandon+abandon+about',
    outcome: 'missing-vault-id',
  },
  unknownExtraKey: {
    payload: `${VAULT_TRANSFER_GOLDEN_PAYLOAD}&future=ignored`,
    expected: EXPECTED,
  },
  badChecksum: {
    payload: `btvault1:m=${Array.from({ length: 12 }, () => 'abandon').join('+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}`,
    outcome: 'invalid-mnemonic',
  },
  elevenWords: {
    payload: `btvault1:m=${Array.from({ length: 11 }, () => 'abandon').join('+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}`,
    outcome: 'invalid-mnemonic',
  },
  thirteenWords: {
    payload: `btvault1:m=${Array.from({ length: 12 }, () => 'abandon').join('+')}+about&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}`,
    outcome: 'invalid-mnemonic',
  },
  uppercaseWords: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.toUpperCase().replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    },
  },
  plusSpaces: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    },
  },
  percent20Spaces: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '%20')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    },
  },
} as const;
