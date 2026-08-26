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

  it.each([
    ['btvault0:', VECTORS.versionZero],
    ['btvault01:', VECTORS.versionPaddedOne],
    ['btvault02:', VECTORS.versionPaddedTwo],
    ['btvault007:', VECTORS.versionPaddedSeven],
  ])('treats the non-canonical version token %s as not a BetterTrack code', (_token, vector) => {
    expect(rejectedOutcome(vector.payload)).toBe(vector.outcome);
  });

  it('separates the canonical version rule from an integer comparison', () => {
    // The trap this pins: `Number(version) > 1` reads `btvault02:` as 2 and
    // sends the user to the app store, while `version !== '1'` reads
    // `btvault01:` as foreign. Only a shape check first makes the two agree.
    expect(rejectedOutcome(VECTORS.versionPaddedTwo.payload)).not.toBe('update-required');
    expect(rejectedOutcome(VECTORS.versionPaddedOne.payload)).toBe(
      rejectedOutcome(VECTORS.versionZero.payload),
    );
    expect(rejectedOutcome(VECTORS.unknownPrefix.payload)).toBe('update-required');
  });

  it('rejects a bare string as not a BetterTrack code', () => {
    expect(rejectedOutcome(VECTORS.bareString.payload)).toBe(VECTORS.bareString.outcome);
  });

  it('rejects a Wi-Fi QR as not a BetterTrack code', () => {
    expect(rejectedOutcome(VECTORS.wifiQr.payload)).toBe(VECTORS.wifiQr.outcome);
  });

  it('rejects a query delimiter ahead of the form-encoded body as malformed', () => {
    expect(rejectedOutcome(VECTORS.leadingQuestionMark.payload)).toBe(
      VECTORS.leadingQuestionMark.outcome,
    );
  });

  it('reports the same structural outcome for a leading delimiter whichever key leads', () => {
    // The old `missing-mnemonic` answer was an artifact of `m` being read
    // first: `?v=…&m=…` would have reported `missing-vault-id` instead. A
    // structural violation must not depend on key order.
    expect(rejectedOutcome(VECTORS.leadingQuestionMarkVaultIdFirst.payload)).toBe(
      VECTORS.leadingQuestionMarkVaultIdFirst.outcome,
    );
    expect(rejectedOutcome(VECTORS.leadingQuestionMarkVaultIdFirst.payload)).toBe(
      rejectedOutcome(VECTORS.leadingQuestionMark.payload),
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

  it('treats a control-only display hint as absent', () => {
    // JS `trim()` does NOT strip U+001F, so this is exactly the vector that
    // would survive as a one-character control name on the web client while
    // Kotlin's `trim()` dropped it.
    expect(parseVaultTransferPayload(VECTORS.controlOnlyName.payload)).toEqual(
      VECTORS.controlOnlyName.expected,
    );
  });

  it('treats a byte-order-mark-only display hint as absent', () => {
    // The mirror case: U+FEFF is neither White_Space nor a C0/C1 control, so
    // Kotlin's `trim()` keeps it while JS drops it.
    expect(parseVaultTransferPayload(VECTORS.byteOrderMarkName.payload)).toEqual(
      VECTORS.byteOrderMarkName.expected,
    );
  });

  it('trims surrounding control characters off a display hint', () => {
    expect(parseVaultTransferPayload(VECTORS.controlPaddedName.payload)).toEqual(
      VECTORS.controlPaddedName.expected,
    );
  });

  it('keeps a control character inside a display hint', () => {
    // Only the EDGES are trimmed; the wire preserves the decoded value exactly.
    // (The render sanitizer, not the parser, is what strips interior controls.)
    const parsed = parseVaultTransferPayload(
      `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=a%1Fb`,
    );

    expect(parsed.name).toBe('a\u001Fb');
  });

  it('trims the display hint before applying the 64-code-point cap', () => {
    // Cap-then-trim would count the two padding spaces, see 66 code points and
    // fail the whole transfer with `invalid-name`.
    expect(parseVaultTransferPayload(VECTORS.paddedMaxLengthName.payload)).toEqual(
      VECTORS.paddedMaxLengthName.expected,
    );
    expect(parseVaultTransferPayload(VECTORS.paddedMaxLengthName.payload).name).toHaveLength(
      VAULT_TRANSFER_NAME_MAX_CHARS,
    );
  });

  it('still rejects a hint that is over the cap after trimming', () => {
    expect(
      rejectedOutcome(
        `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=%20${'a'.repeat(VAULT_TRANSFER_NAME_MAX_CHARS + 1)}%20`,
      ),
    ).toBe('invalid-name');
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
