import type { VaultKeyFingerprint } from '@bettertrack/contracts';

export const ENDPOINT_KEYSTORE_VERSION = 1;
export const ENDPOINT_KEYSTORE_DEFAULT_CUSTODY = 'wrapped' as const;
export const ENDPOINT_PASSWORD_KDF = {
  algorithm: 'argon2id',
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
  saltBytes: 16,
  keyBytes: 32,
} as const;

export interface EndpointPasswordMetadataV1 {
  version: typeof ENDPOINT_KEYSTORE_VERSION;
  kdf: {
    algorithm: typeof ENDPOINT_PASSWORD_KDF.algorithm;
    memoryKiB: typeof ENDPOINT_PASSWORD_KDF.memoryKiB;
    iterations: typeof ENDPOINT_PASSWORD_KDF.iterations;
    parallelism: typeof ENDPOINT_PASSWORD_KDF.parallelism;
    salt: string;
  };
  wrapCheck: {
    algorithm: 'A256GCM';
    iv: string;
    ciphertext: string;
  };
  lockout: {
    failures: number;
    lockedUntil: number | null;
  };
}

export interface WrappedPhrasePayloadV1 {
  version: typeof ENDPOINT_KEYSTORE_VERSION;
  algorithm: 'A256GCM';
  iv: string;
  ciphertext: string;
}

export interface PlainPhrasePayloadV1 {
  version: typeof ENDPOINT_KEYSTORE_VERSION;
  encoding: 'bip39-entropy-base64url';
  entropy: string;
}

/** The binding endpoint record shape from paranoid-design §12. */
export type StoredPhraseEntry =
  | {
      vaultId: string;
      custody: 'wrapped';
      payload: WrappedPhrasePayloadV1;
    }
  | {
      vaultId: string;
      custody: 'plain';
      payload: PlainPhrasePayloadV1;
    };

export type EndpointVaultState =
  | {
      status: 'stored+wrapped';
      session: 'locked';
      requiredAction:
        | { kind: 'unlock'; credential: 'device-password' }
        | {
            kind: 'wait-or-reset';
            retryAt: number;
            alternative: 'reset-endpoint-keystore';
          };
    }
  | {
      status: 'stored+wrapped';
      session: 'unlocked';
      requiredAction: { kind: 'open-silently' };
    }
  | {
      status: 'stored+plain';
      requiredAction: { kind: 'open-silently' };
    }
  | {
      status: 'not-on-this-endpoint';
      requiredAction: {
        kind: 'provide-phrase';
        methods: readonly ['enter-words', 'scan-qr'];
      };
    }
  | {
      status: 'endpoint-keystore-invalid';
      requiredAction: { kind: 'reset-endpoint-keystore' };
    };

export interface OpenedVault {
  vaultId: string;
  keyId: string;
  keyFingerprint: VaultKeyFingerprint;
}

/** Fetches opaque header-envelope bytes from any reachable E1/E5 medium. */
export type FetchVaultHeaderEnvelope = (input: { vaultId: string }) => Promise<Uint8Array>;

export interface StoreWrappedPhraseInput {
  vaultId: string;
  mnemonic: string;
  /** Required when no device-password session is currently unlocked. */
  devicePassword?: string;
  expectedFingerprint?: VaultKeyFingerprint;
  fetchHeaderEnvelope: FetchVaultHeaderEnvelope;
}

export interface StorePlainPhraseInput {
  vaultId: string;
  mnemonic: string;
  acknowledgment: PlainCustodyAcknowledgmentToken;
  expectedFingerprint?: VaultKeyFingerprint;
  fetchHeaderEnvelope: FetchVaultHeaderEnvelope;
}

declare const plainCustodyAcknowledgmentBrand: unique symbol;

/**
 * Runtime-issued, one-use proof that E8 completed the strong warning rung.
 * A type assertion cannot forge it because the keystore also checks identity.
 */
export interface PlainCustodyAcknowledgmentToken {
  readonly [plainCustodyAcknowledgmentBrand]: true;
}

export interface KeystoreResetResult {
  scope: 'this-endpoint-only';
  storedPhrases: 'removed';
  remoteVaultCopies: 'server-and-drive-untouched';
  vaultDataLost: false;
  nextAction: 're-enter-words-or-scan-qr';
}

export interface EndpointUnlockResult {
  unlockedVaultIds: readonly string[];
}
