import { describe, expect, it } from 'vitest';

import {
  VAULT_TRANSFER_CONFORMANCE_VECTORS as VECTORS,
  VAULT_TRANSFER_GOLDEN_PAYLOAD,
  VAULT_TRANSFER_VECTOR_FINGERPRINT,
  VAULT_TRANSFER_VECTOR_MNEMONIC,
  VAULT_TRANSFER_VECTOR_NAME,
  VAULT_TRANSFER_VECTOR_VAULT_ID,
} from './conformanceVectors';
import {
  parseVaultTransferPayload,
  serializeVaultTransferPayload,
  VaultTransferPayloadError,
  type VaultTransferPayloadErrorOutcome,
} from './payload';

function rejectedOutcome(payload: string): VaultTransferPayloadErrorOutcome | null {
  try {
    parseVaultTransferPayload(payload);
    return null;
  } catch (error) {
    return error instanceof VaultTransferPayloadError ? error.outcome : null;
  }
}

describe('btvault1 payload conformance vectors', () => {
  it('round-trips the valid vector', () => {
    const parsed = parseVaultTransferPayload(VECTORS.validRoundTrip.payload);
    expect(serializeVaultTransferPayload(parsed)).toBe(VECTORS.validRoundTrip.payload);
  });

  it('rejects an unknown version with the update-app outcome', () => {
    expect(rejectedOutcome(VECTORS.unknownPrefix.payload)).toBe(VECTORS.unknownPrefix.outcome);
  });

  it('rejects a bare string with the update-app outcome', () => {
    expect(rejectedOutcome(VECTORS.bareString.payload)).toBe(VECTORS.bareString.outcome);
  });

  it('rejects a missing mnemonic', () => {
    expect(rejectedOutcome(VECTORS.missingMnemonic.payload)).toBe(VECTORS.missingMnemonic.outcome);
  });

  it('rejects a missing vault id', () => {
    expect(rejectedOutcome(VECTORS.missingVaultId.payload)).toBe(VECTORS.missingVaultId.outcome);
  });

  it('ignores an unknown additive key', () => {
    expect(parseVaultTransferPayload(VECTORS.unknownExtraKey.payload)).toEqual(
      VECTORS.unknownExtraKey.expected,
    );
  });

  it('rejects a checksum-invalid mnemonic', () => {
    expect(rejectedOutcome(VECTORS.badChecksum.payload)).toBe(VECTORS.badChecksum.outcome);
  });

  it('rejects eleven words', () => {
    expect(rejectedOutcome(VECTORS.elevenWords.payload)).toBe(VECTORS.elevenWords.outcome);
  });

  it('rejects thirteen words', () => {
    expect(rejectedOutcome(VECTORS.thirteenWords.payload)).toBe(VECTORS.thirteenWords.outcome);
  });

  it('normalizes uppercase words to the binding lowercase form', () => {
    expect(parseVaultTransferPayload(VECTORS.uppercaseWords.payload)).toEqual(
      VECTORS.uppercaseWords.expected,
    );
  });

  it('decodes plus signs as single spaces', () => {
    expect(parseVaultTransferPayload(VECTORS.plusSpaces.payload)).toEqual(
      VECTORS.plusSpaces.expected,
    );
  });

  it('decodes percent-20 as single spaces', () => {
    expect(parseVaultTransferPayload(VECTORS.percent20Spaces.payload)).toEqual(
      VECTORS.percent20Spaces.expected,
    );
  });
});

it('pins the fixed serializer golden', () => {
  expect(
    serializeVaultTransferPayload({
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      name: VAULT_TRANSFER_VECTOR_NAME,
      fingerprint: VAULT_TRANSFER_VECTOR_FINGERPRINT,
    }),
  ).toBe(VAULT_TRANSFER_GOLDEN_PAYLOAD);
});
