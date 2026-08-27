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
  // The version token is a CANONICAL decimal integer: `^[1-9][0-9]*$`. A
  // zero-padded or zero-valued token is not a version we ever minted, so it is
  // not our code at all — never a "newer BetterTrack, go update" prompt. These
  // four pin that a client must not run its integer parser over the token
  // before validating its shape (Kotlin `"007".toInt()` == 7 would otherwise
  // send this user to the app store for a code we never emitted).
  versionZero: {
    payload: VAULT_TRANSFER_GOLDEN_PAYLOAD.replace('btvault1:', 'btvault0:'),
    outcome: 'not-a-bettertrack-code',
  },
  versionPaddedOne: {
    payload: VAULT_TRANSFER_GOLDEN_PAYLOAD.replace('btvault1:', 'btvault01:'),
    outcome: 'not-a-bettertrack-code',
  },
  versionPaddedTwo: {
    payload: VAULT_TRANSFER_GOLDEN_PAYLOAD.replace('btvault1:', 'btvault02:'),
    outcome: 'not-a-bettertrack-code',
  },
  versionPaddedSeven: {
    payload: VAULT_TRANSFER_GOLDEN_PAYLOAD.replace('btvault1:', 'btvault007:'),
    outcome: 'not-a-bettertrack-code',
  },
  bareString: {
    payload: VAULT_TRANSFER_GOLDEN_PAYLOAD.slice('btvault1:'.length),
    outcome: 'not-a-bettertrack-code',
  },
  wifiQr: {
    payload: 'WIFI:T:WPA;S:CafeGlockenspiel;P:hunter2;;',
    outcome: 'not-a-bettertrack-code',
  },
  // A leading `?` is a STRUCTURAL violation of the body grammar, not a missing
  // key: `URLSearchParams` would silently strip it and accept a URL-shaped body.
  // Reporting it as a missing key made the outcome depend on which key happened
  // to come first, so both orderings are pinned here — `malformed` by
  // construction, whichever key leads.
  leadingQuestionMark: {
    payload: `btvault1:?m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}`,
    outcome: 'malformed',
  },
  leadingQuestionMarkVaultIdFirst: {
    payload: `btvault1:?v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}`,
    outcome: 'malformed',
  },
  blankName: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    },
  },
  whitespaceName: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=%20%20`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    },
  },
  paddedName: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=%20${VAULT_TRANSFER_VECTOR_NAME.replaceAll(' ', '+')}%20`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      name: VAULT_TRANSFER_VECTOR_NAME,
    },
  },
  // The normative trim set for `n` is Unicode White_Space ∪ C0/C1 controls ∪
  // U+FEFF — deliberately NOT "whatever the host runtime's trim does". JS
  // `trim()` strips U+FEFF but leaves U+001C–U+001F; Kotlin's `isWhitespace`
  // does the exact opposite, so these three vectors are the ones that would
  // have diverged between the two clients.
  controlOnlyName: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=%1F`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    },
  },
  byteOrderMarkName: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=%EF%BB%BF`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    },
  },
  controlPaddedName: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=%1FUrlaub%1F`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      name: 'Urlaub',
    },
  },
  // Trim runs BEFORE the 64-code-point cap. Padding a name that is already at
  // the cap must therefore be accepted; capping first would see 66 code points
  // and reject the whole transfer as `invalid-name`.
  paddedMaxLengthName: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=%20${'a'.repeat(64)}%20`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      name: 'a'.repeat(64),
    },
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
  duplicateMnemonic: {
    payload: `${VAULT_TRANSFER_GOLDEN_PAYLOAD}&m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}`,
    outcome: 'invalid-mnemonic',
  },
  duplicateVaultId: {
    payload: `${VAULT_TRANSFER_GOLDEN_PAYLOAD}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}`,
    outcome: 'invalid-vault-id',
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
  nonAsciiName: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=Caf%C3%A9`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      name: 'Café',
    },
  },
  maxLengthComposedName: {
    payload: `btvault1:m=${VAULT_TRANSFER_VECTOR_MNEMONIC.replaceAll(' ', '+')}&v=${VAULT_TRANSFER_VECTOR_VAULT_ID}&n=${'%C3%A9'.repeat(64)}`,
    expected: {
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      name: 'é'.repeat(64),
    },
  },
} as const;
