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
  serializeVaultTransferPayloadWithinBudget,
  VAULT_TRANSFER_NAME_MAX_CHARS,
  VAULT_TRANSFER_PAYLOAD_MAX_BYTES,
  vaultTransferPayloadByteLength,
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

  it('rejects a bare string as not a BetterTrack code', () => {
    expect(rejectedOutcome(VECTORS.bareString.payload)).toBe(VECTORS.bareString.outcome);
  });

  it('rejects a Wi-Fi QR as not a BetterTrack code', () => {
    expect(rejectedOutcome(VECTORS.wifiQr.payload)).toBe(VECTORS.wifiQr.outcome);
  });

  it('rejects a query delimiter ahead of the form-encoded body', () => {
    expect(rejectedOutcome(VECTORS.leadingQuestionMark.payload)).toBe(
      VECTORS.leadingQuestionMark.outcome,
    );
  });

  it('treats a blank display hint as absent', () => {
    expect(parseVaultTransferPayload(VECTORS.blankName.payload)).toEqual(
      VECTORS.blankName.expected,
    );
  });

  it('treats a whitespace-only display hint as absent', () => {
    expect(parseVaultTransferPayload(VECTORS.whitespaceName.payload)).toEqual(
      VECTORS.whitespaceName.expected,
    );
  });

  it('trims surrounding whitespace off a display hint but keeps its interior', () => {
    expect(parseVaultTransferPayload(VECTORS.paddedName.payload)).toEqual(
      VECTORS.paddedName.expected,
    );
  });

  it('preserves a normal display hint through parse unchanged', () => {
    expect(parseVaultTransferPayload(VECTORS.validRoundTrip.payload).name).toBe(
      VAULT_TRANSFER_VECTOR_NAME,
    );
  });

  it('rejects a missing mnemonic', () => {
    expect(rejectedOutcome(VECTORS.missingMnemonic.payload)).toBe(VECTORS.missingMnemonic.outcome);
  });

  it('rejects a missing vault id', () => {
    expect(rejectedOutcome(VECTORS.missingVaultId.payload)).toBe(VECTORS.missingVaultId.outcome);
  });

  it('rejects duplicate mnemonic keys', () => {
    expect(rejectedOutcome(VECTORS.duplicateMnemonic.payload)).toBe(
      VECTORS.duplicateMnemonic.outcome,
    );
  });

  it('rejects duplicate vault-id keys', () => {
    expect(rejectedOutcome(VECTORS.duplicateVaultId.payload)).toBe(
      VECTORS.duplicateVaultId.outcome,
    );
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

  it('preserves a non-ASCII display hint without Unicode normalization', () => {
    const parsed = parseVaultTransferPayload(VECTORS.nonAsciiName.payload);
    expect(parsed).toEqual(VECTORS.nonAsciiName.expected);
    expect(serializeVaultTransferPayload(parsed)).toBe(VECTORS.nonAsciiName.payload);
  });

  it('preserves a composed display hint at the exact 64-code-point boundary', () => {
    const parsed = parseVaultTransferPayload(VECTORS.maxLengthComposedName.payload);
    expect(parsed).toEqual(VECTORS.maxLengthComposedName.expected);
    expect(serializeVaultTransferPayload(parsed)).toBe(VECTORS.maxLengthComposedName.payload);
  });
});

/**
 * §13 budgets "~150–220 chars … a comfortably scannable version-7-ish code".
 * The `n` hint is the only member a sender chooses, so it is what gives way —
 * measured in WIRE BYTES, because vault names are cleartext free-form (§21 Q4)
 * and one emoji costs four bytes and twelve percent-encoded characters.
 */
describe('sender payload byte budget', () => {
  const required = {
    mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
    vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    fingerprint: VAULT_TRANSFER_VECTOR_FINGERPRINT,
  };

  it('keeps a short display hint', () => {
    const payload = serializeVaultTransferPayloadWithinBudget({
      ...required,
      name: VAULT_TRANSFER_VECTOR_NAME,
    });

    expect(payload).toBe(VAULT_TRANSFER_GOLDEN_PAYLOAD);
    expect(vaultTransferPayloadByteLength(payload)).toBeLessThanOrEqual(
      VAULT_TRANSFER_PAYLOAD_MAX_BYTES,
    );
  });

  it('keeps a multi-byte hint that still fits the budget', () => {
    const name = 'Café Wien';
    const payload = serializeVaultTransferPayloadWithinBudget({ ...required, name });

    expect(parseVaultTransferPayload(payload)).toMatchObject({ name });
    expect(vaultTransferPayloadByteLength(payload)).toBeLessThanOrEqual(
      VAULT_TRANSFER_PAYLOAD_MAX_BYTES,
    );
  });

  it('drops a multi-byte hint that would blow the budget, keeping every required member', () => {
    const payload = serializeVaultTransferPayloadWithinBudget({
      ...required,
      name: '🔐'.repeat(64),
    });

    expect(parseVaultTransferPayload(payload)).toEqual({
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      fingerprint: VAULT_TRANSFER_VECTOR_FINGERPRINT,
    });
    expect(vaultTransferPayloadByteLength(payload)).toBeLessThanOrEqual(
      VAULT_TRANSFER_PAYLOAD_MAX_BYTES,
    );
  });

  it('drops a wire-legal 64-code-point composed hint that no longer fits', () => {
    const payload = serializeVaultTransferPayloadWithinBudget({
      ...required,
      name: 'é'.repeat(VAULT_TRANSFER_NAME_MAX_CHARS),
    });

    // The WIRE still accepts it — only this sender declines to emit it.
    expect(parseVaultTransferPayload(VECTORS.maxLengthComposedName.payload).name).toBe(
      'é'.repeat(VAULT_TRANSFER_NAME_MAX_CHARS),
    );
    expect(parseVaultTransferPayload(payload).name).toBeUndefined();
  });

  it('drops a hint the wire itself rejects instead of failing the transfer', () => {
    const payload = serializeVaultTransferPayloadWithinBudget({
      ...required,
      name: 'x'.repeat(VAULT_TRANSFER_NAME_MAX_CHARS + 1),
    });

    expect(parseVaultTransferPayload(payload).name).toBeUndefined();
  });

  it('pins the byte ceiling itself', () => {
    expect(VAULT_TRANSFER_PAYLOAD_MAX_BYTES).toBe(220);
    expect(vaultTransferPayloadByteLength('é')).toBe(2);
    expect(vaultTransferPayloadByteLength('🔐')).toBe(4);
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
