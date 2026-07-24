import {
  type VaultDocumentV1,
  type VaultEnvelopeHeader,
  type VaultWrappedKey,
} from '@bettertrack/contracts';

import {
  decryptVaultDocument,
  deriveVaultKek,
  encryptVaultDocument,
  generateVaultKey,
  newKdfParams,
  type RandomBytes,
  type VaultCryptoDeps,
  unwrapVaultKey,
  wrapVaultKey,
} from './crypto';
import { zeroBytes } from './bytes';
import { decodeVaultEnvelope } from './envelope';
import { VaultCryptoError } from './errors';

export interface RekeyHeaderMetadata {
  vaultVersion: number;
  deviceId: string;
  writeId: string;
  writtenAt: string;
}

export interface PassphraseChangeInput {
  envelope: Uint8Array;
  oldPassphrase: string;
  newPassphrase: string;
  metadata: RekeyHeaderMetadata;
  randomBytes?: RandomBytes;
  cryptoDeps?: VaultCryptoDeps;
}

export interface VaultKeyRotationInput {
  envelope: Uint8Array;
  passphrase: string;
  nextKeyId: string;
  metadata: RekeyHeaderMetadata;
  randomBytes?: RandomBytes;
  cryptoDeps?: VaultCryptoDeps;
}

export interface RekeyResult {
  envelope: Uint8Array;
  header: VaultEnvelopeHeader;
  document: VaultDocumentV1;
  vaultKey: Uint8Array;
}

/**
 * Re-encrypts under the same VK after changing a passphrase. Complete header AAD
 * means this cannot be a header-only operation: it gets a fresh content IV.
 * The caller replaces active state only after this promise succeeds.
 */
export async function changeVaultPassphrase(input: PassphraseChangeInput): Promise<RekeyResult> {
  const decoded = decodeVaultEnvelope(input.envelope);
  const currentWrapper = activeWrapper(decoded.header);
  const oldKek = await deriveVaultKek(input.oldPassphrase, currentWrapper.kdf, input.cryptoDeps);
  let vaultKey: Uint8Array | undefined;
  let newKek: Uint8Array | undefined;
  try {
    vaultKey = await unwrapActiveKey(decoded.header, currentWrapper, oldKek);
    const { document } = await decryptVaultDocument(input.envelope, vaultKey);
    const kdf = newKdfParams(input.randomBytes);
    newKek = await deriveVaultKek(input.newPassphrase, kdf, input.cryptoDeps);
    const wrappedKey = await wrapVaultKey(
      vaultKey,
      newKek,
      decoded.header.keyId,
      kdf,
      input.randomBytes,
    );
    return await reencrypt(
      document,
      vaultKey,
      decoded.header,
      [wrappedKey],
      input.metadata,
      input.randomBytes,
    );
  } finally {
    zeroBytes(oldKek);
    if (newKek != null) zeroBytes(newKek);
    // Return ownership of a successful new result's key; never clear it here.
    if (vaultKey != null) zeroBytes(vaultKey);
  }
}

/** Fully re-encrypts under a fresh VK after a suspected key compromise. */
export async function rotateVaultKey(input: VaultKeyRotationInput): Promise<RekeyResult> {
  const decoded = decodeVaultEnvelope(input.envelope);
  const currentWrapper = activeWrapper(decoded.header);
  const oldKek = await deriveVaultKek(input.passphrase, currentWrapper.kdf, input.cryptoDeps);
  let oldVaultKey: Uint8Array | undefined;
  let nextVaultKey: Uint8Array | undefined;
  try {
    oldVaultKey = await unwrapActiveKey(decoded.header, currentWrapper, oldKek);
    const { document } = await decryptVaultDocument(input.envelope, oldVaultKey);
    nextVaultKey = generateVaultKey(input.randomBytes);
    const kdf = newKdfParams(input.randomBytes);
    const nextKek = await deriveVaultKek(input.passphrase, kdf, input.cryptoDeps);
    try {
      const wrappedKey = await wrapVaultKey(
        nextVaultKey,
        nextKek,
        input.nextKeyId,
        kdf,
        input.randomBytes,
      );
      return await reencrypt(
        document,
        nextVaultKey,
        decoded.header,
        [wrappedKey],
        input.metadata,
        input.randomBytes,
        input.nextKeyId,
      );
    } finally {
      zeroBytes(nextKek);
    }
  } finally {
    zeroBytes(oldKek);
    if (oldVaultKey != null) zeroBytes(oldVaultKey);
    if (nextVaultKey != null) zeroBytes(nextVaultKey);
  }
}

async function unwrapActiveKey(
  header: VaultEnvelopeHeader,
  wrapped: VaultWrappedKey,
  kek: Uint8Array,
): Promise<Uint8Array> {
  return unwrapVaultKey(wrapped, header.keyId, kek);
}

async function reencrypt(
  document: VaultDocumentV1,
  vaultKey: Uint8Array,
  priorHeader: VaultEnvelopeHeader,
  wrappedKeys: VaultWrappedKey[],
  metadata: RekeyHeaderMetadata,
  randomBytes?: RandomBytes,
  keyId = priorHeader.keyId,
): Promise<RekeyResult> {
  const encrypted = await encryptVaultDocument({
    document,
    vaultKey,
    header: {
      keyId,
      wrappedKeys,
      vaultVersion: metadata.vaultVersion,
      deviceId: metadata.deviceId,
      writeId: metadata.writeId,
      writtenAt: metadata.writtenAt,
    },
    randomBytes,
  });
  return { ...encrypted, document, vaultKey: vaultKey.slice() };
}

function activeWrapper(header: VaultEnvelopeHeader): VaultWrappedKey {
  const wrapper = header.wrappedKeys.find((item) => item.keyId === header.keyId);
  if (wrapper == null) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'Vault header has no wrapper for its active key.',
    );
  }
  return wrapper;
}
