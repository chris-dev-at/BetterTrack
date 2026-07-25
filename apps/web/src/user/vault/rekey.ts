import {
  type VaultEnvelopeHeader,
  type VaultOnDiskDocumentV1,
  type VaultWrappedKey,
} from '@bettertrack/contracts';

import {
  decryptVaultDocument,
  deriveVaultKek,
  encryptVaultDocument,
  generateVaultKey,
  newKdfParams,
  secureRandomBytes,
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
  metadata: RekeyHeaderMetadata;
  randomBytes?: RandomBytes;
  cryptoDeps?: VaultCryptoDeps;
  keyIdGenerator?: VaultKeyIdGenerator;
}

export type VaultKeyIdGenerator = () => string;

export interface RekeyResult {
  envelope: Uint8Array;
  header: VaultEnvelopeHeader;
  document: VaultOnDiskDocumentV1;
  vaultKey: Uint8Array;
}

/**
 * Re-encrypts under the same VK after changing a passphrase. Complete header AAD
 * means this cannot be a header-only operation: it gets a fresh content IV.
 * The caller replaces active state only after this promise succeeds.
 */
export async function changeVaultPassphrase(input: PassphraseChangeInput): Promise<RekeyResult> {
  if (input.oldPassphrase === input.newPassphrase) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'Vault passphrase change requires a different passphrase.',
    );
  }
  const decoded = decodeVaultEnvelope(input.envelope);
  assertFreshRekeyMetadata(decoded.header, input.metadata);
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

/** Fully re-encrypts under a fresh VK and a core-generated key ID after a compromise. */
export async function rotateVaultKey(input: VaultKeyRotationInput): Promise<RekeyResult> {
  const decoded = decodeVaultEnvelope(input.envelope);
  assertFreshRekeyMetadata(decoded.header, input.metadata);
  const nextKeyId = generateFreshKeyId(decoded.header.keyId, input.keyIdGenerator);
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
        nextKeyId,
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
        nextKeyId,
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

function generateFreshKeyId(
  currentKeyId: string,
  keyIdGenerator: VaultKeyIdGenerator = generateVaultKeyId,
): string {
  const nextKeyId = keyIdGenerator();
  if (!isUuid(nextKeyId) || nextKeyId.toLowerCase() === currentKeyId.toLowerCase()) {
    throw new VaultCryptoError('envelope-invalid', 'Vault key rotation requires a fresh key id.');
  }
  return nextKeyId;
}

function generateVaultKeyId(): string {
  const bytes = secureRandomBytes(16);
  let milliseconds = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = milliseconds & 0xff;
    milliseconds = Math.floor(milliseconds / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function unwrapActiveKey(
  header: VaultEnvelopeHeader,
  wrapped: VaultWrappedKey,
  kek: Uint8Array,
): Promise<Uint8Array> {
  return unwrapVaultKey(wrapped, header.keyId, kek);
}

function assertFreshRekeyMetadata(
  priorHeader: VaultEnvelopeHeader,
  metadata: RekeyHeaderMetadata,
): void {
  if (metadata.vaultVersion <= priorHeader.vaultVersion) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'Re-encryption requires a vault version greater than the prior version.',
    );
  }
  if (metadata.writeId.toLowerCase() === priorHeader.writeId.toLowerCase()) {
    throw new VaultCryptoError('envelope-invalid', 'Re-encryption requires a fresh write id.');
  }
}

async function reencrypt(
  document: VaultOnDiskDocumentV1,
  vaultKey: Uint8Array,
  priorHeader: VaultEnvelopeHeader,
  wrappedKeys: VaultWrappedKey[],
  metadata: RekeyHeaderMetadata,
  randomBytes?: RandomBytes,
  keyId = priorHeader.keyId,
): Promise<RekeyResult> {
  assertFreshRekeyMetadata(priorHeader, metadata);
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
