import { deflateSync, inflateSync } from 'fflate';
import { argon2id } from 'hash-wasm';

import {
  VAULT_CONTENT_CIPHER,
  VAULT_DOCUMENT_VERSION,
  VAULT_FORMAT_VERSION,
  VAULT_KDF_ALG,
  type VaultDocumentV1,
  type VaultEnvelopeHeader,
  type VaultKdfParams,
  type VaultWrappedKey,
  vaultDocumentV1Schema,
} from '@bettertrack/contracts';

import { base64ToBytes, bytesToBase64, decodeUtf8, utf8, zeroBytes } from './bytes';
import { decodeVaultEnvelope, encodeVaultEnvelope, serializeVaultHeader } from './envelope';
import { asVaultCryptoError, VaultCryptoError } from './errors';

export const VAULT_KEY_BYTES = 32;
export const VAULT_IV_BYTES = 12;
export const VAULT_SALT_BYTES = 16;
export const VAULT_ARGON2_PARAMS = { alg: VAULT_KDF_ALG, m: 65536, t: 3, p: 1 } as const;

export type RandomBytes = (length: number) => Uint8Array;

export interface VaultCryptoDeps {
  randomBytes?: RandomBytes;
  argon2?: (options: {
    password: Uint8Array;
    salt: Uint8Array;
    iterations: number;
    parallelism: number;
    memorySize: number;
    hashLength: number;
    outputType: 'binary';
  }) => Promise<Uint8Array>;
}

export type VaultKeyMaterial = Uint8Array | CryptoKey;

export interface EncryptVaultInput {
  document: VaultDocumentV1;
  vaultKey: VaultKeyMaterial;
  header: Omit<VaultEnvelopeHeader, 'cipher' | 'iv' | 'formatVersion' | 'schemaVersion'>;
  randomBytes?: RandomBytes;
}

export interface EncryptedVault {
  envelope: Uint8Array;
  header: VaultEnvelopeHeader;
}

export function secureRandomBytes(length: number): Uint8Array {
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues == null) {
    throw new VaultCryptoError('unsupported-crypto', 'WebCrypto CSPRNG is unavailable.');
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

export function generateVaultKey(randomBytes: RandomBytes = secureRandomBytes): Uint8Array {
  return randomBytes(VAULT_KEY_BYTES);
}

export function generateVaultSalt(randomBytes: RandomBytes = secureRandomBytes): Uint8Array {
  return randomBytes(VAULT_SALT_BYTES);
}

export async function deriveVaultKek(
  passphrase: string,
  params: VaultKdfParams,
  deps: VaultCryptoDeps = {},
): Promise<Uint8Array> {
  if (
    params.alg !== VAULT_ARGON2_PARAMS.alg ||
    params.m !== VAULT_ARGON2_PARAMS.m ||
    params.t !== VAULT_ARGON2_PARAMS.t ||
    params.p !== VAULT_ARGON2_PARAMS.p
  ) {
    throw new VaultCryptoError(
      'kdf-failed',
      'Vault KDF parameters are not the required Argon2id profile.',
    );
  }
  const password = utf8(passphrase);
  let salt: Uint8Array | undefined;
  try {
    salt = base64ToBytes(params.salt, 'envelope-invalid');
    if (salt.length !== VAULT_SALT_BYTES) {
      throw new VaultCryptoError('kdf-failed', 'Vault KDF salt has an invalid length.');
    }
    const derive = deps.argon2 ?? argon2id;
    const key = await derive({
      password,
      salt,
      iterations: params.t,
      parallelism: params.p,
      memorySize: params.m,
      hashLength: VAULT_KEY_BYTES,
      outputType: 'binary',
    });
    if (key.length !== VAULT_KEY_BYTES) {
      throw new VaultCryptoError('kdf-failed', 'Argon2id returned an invalid KEK length.');
    }
    return new Uint8Array(key);
  } catch (cause) {
    throw asVaultCryptoError('kdf-failed', 'Could not derive the vault KEK.', cause);
  } finally {
    zeroBytes(password);
    if (salt != null) zeroBytes(salt);
  }
}

export function newKdfParams(randomBytes: RandomBytes = secureRandomBytes): VaultKdfParams {
  return { ...VAULT_ARGON2_PARAMS, salt: bytesToBase64(generateVaultSalt(randomBytes)) };
}

export async function wrapVaultKey(
  vaultKey: Uint8Array,
  kek: Uint8Array,
  keyId: string,
  kdf: VaultKdfParams,
  randomBytes: RandomBytes = secureRandomBytes,
): Promise<VaultWrappedKey> {
  requireKeyLength(vaultKey, 'Vault key');
  requireKeyLength(kek, 'KEK');
  const iv = newVaultIv(randomBytes, 'Wrapped vault key');
  try {
    const encrypted = await aesGcmEncrypt(kek, iv, vaultKey, utf8(keyId));
    return {
      keyId,
      kdf,
      wrappedVk: bytesToBase64(concatBytes(iv, encrypted)),
    };
  } finally {
    zeroBytes(iv);
  }
}

export async function unwrapVaultKey(
  wrapped: VaultWrappedKey,
  activeKeyId: string,
  kek: Uint8Array,
): Promise<Uint8Array> {
  if (wrapped.keyId !== activeKeyId) {
    throw new VaultCryptoError(
      'authentication-failed',
      'Wrapped vault key does not match the active key id.',
    );
  }
  requireKeyLength(kek, 'KEK');
  let payload: Uint8Array | undefined;
  try {
    payload = base64ToBytes(wrapped.wrappedVk, 'envelope-invalid');
    if (payload.length <= VAULT_IV_BYTES + 16) {
      throw new VaultCryptoError(
        'authentication-failed',
        'Wrapped vault key is structurally invalid.',
      );
    }
    const vaultKey = await aesGcmDecrypt(
      kek,
      payload.subarray(0, VAULT_IV_BYTES),
      payload.subarray(VAULT_IV_BYTES),
      utf8(activeKeyId),
    );
    requireKeyLength(vaultKey, 'Unwrapped vault key');
    return vaultKey;
  } catch (cause) {
    throw asVaultCryptoError(
      'authentication-failed',
      'Could not authenticate the vault key.',
      cause,
    );
  } finally {
    if (payload != null) zeroBytes(payload);
  }
}

export async function encryptVaultDocument(input: EncryptVaultInput): Promise<EncryptedVault> {
  requireKeyMaterial(input.vaultKey, 'Vault key');
  const parsedDocument = vaultDocumentV1Schema.safeParse(input.document);
  if (!parsedDocument.success) {
    throw new VaultCryptoError(
      'document-invalid',
      'Vault document does not match the current schema.',
    );
  }
  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const iv = newVaultIv(randomBytes, 'Vault content');
  let plaintext: Uint8Array | undefined;
  let compressed: Uint8Array | undefined;
  try {
    const header: VaultEnvelopeHeader = {
      ...input.header,
      formatVersion: VAULT_FORMAT_VERSION,
      schemaVersion: VAULT_DOCUMENT_VERSION,
      cipher: VAULT_CONTENT_CIPHER,
      iv: bytesToBase64(iv),
    };
    const headerBytes = serializeVaultHeader(header);
    plaintext = utf8(JSON.stringify(parsedDocument.data));
    compressed = deflateSync(plaintext);
    const ciphertext = await aesGcmEncrypt(input.vaultKey, iv, compressed, headerBytes);
    return { header, envelope: encodeVaultEnvelope(header, ciphertext) };
  } catch (cause) {
    throw asVaultCryptoError(
      'authentication-failed',
      'Could not encrypt the vault document.',
      cause,
    );
  } finally {
    zeroBytes(iv);
    if (plaintext != null) zeroBytes(plaintext);
    if (compressed != null) zeroBytes(compressed);
  }
}

export async function decryptVaultDocument(
  envelope: Uint8Array,
  vaultKey: VaultKeyMaterial,
): Promise<{ document: VaultDocumentV1; header: VaultEnvelopeHeader }> {
  requireKeyMaterial(vaultKey, 'Vault key');
  const decoded = decodeVaultEnvelope(envelope);
  if (decoded.header.schemaVersion > VAULT_DOCUMENT_VERSION) {
    throw new VaultCryptoError(
      'update-required',
      'This vault document was written by a newer app version.',
    );
  }
  let iv: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    iv = base64ToBytes(decoded.header.iv, 'envelope-invalid');
    if (iv.length !== VAULT_IV_BYTES) {
      throw new VaultCryptoError('envelope-invalid', 'Vault content IV has an invalid length.');
    }
    const compressed = await aesGcmDecrypt(vaultKey, iv, decoded.ciphertext, decoded.headerBytes);
    try {
      plaintext = inflateSync(compressed);
    } finally {
      zeroBytes(compressed);
    }
    let value: unknown;
    try {
      value = JSON.parse(decodeUtf8(plaintext, 'document-invalid'));
    } catch (cause) {
      if (cause instanceof VaultCryptoError) throw cause;
      throw new VaultCryptoError('document-invalid', 'Vault document is not valid JSON.', {
        cause,
      });
    }
    const parsed = vaultDocumentV1Schema.safeParse(value);
    if (!parsed.success) {
      throw new VaultCryptoError(
        'document-invalid',
        'Vault document does not match the current schema.',
      );
    }
    return { document: parsed.data, header: decoded.header };
  } catch (cause) {
    if (cause instanceof VaultCryptoError && cause.code !== 'authentication-failed') throw cause;
    throw asVaultCryptoError(
      'authentication-failed',
      'Could not authenticate and decrypt the vault.',
      cause,
    );
  } finally {
    if (iv != null) zeroBytes(iv);
    if (plaintext != null) zeroBytes(plaintext);
  }
}

async function aesGcmEncrypt(
  keyMaterial: VaultKeyMaterial,
  iv: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const subtle = requireSubtle();
  const key = await aesGcmKey(keyMaterial, ['encrypt']);
  const result = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    key,
    plaintext,
  );
  return new Uint8Array(result);
}

async function aesGcmDecrypt(
  keyMaterial: VaultKeyMaterial,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  try {
    const subtle = requireSubtle();
    const key = await aesGcmKey(keyMaterial, ['decrypt']);
    const result = await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
      key,
      ciphertext,
    );
    return new Uint8Array(result);
  } catch (cause) {
    throw new VaultCryptoError('authentication-failed', 'Vault authentication failed.', { cause });
  }
}

async function aesGcmKey(keyMaterial: VaultKeyMaterial, usages: KeyUsage[]): Promise<CryptoKey> {
  if (keyMaterial instanceof Uint8Array) {
    return requireSubtle().importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, usages);
  }
  if (!isAes256GcmSecretKey(keyMaterial)) {
    throw new VaultCryptoError(
      'authentication-failed',
      'Vault device key must be a 256-bit AES-GCM secret key.',
    );
  }
  return keyMaterial;
}

function requireSubtle(): SubtleCrypto {
  if (globalThis.crypto?.subtle == null) {
    throw new VaultCryptoError('unsupported-crypto', 'WebCrypto AES-GCM is unavailable.');
  }
  return globalThis.crypto.subtle;
}

function requireKeyLength(bytes: Uint8Array, name: string): void {
  if (bytes.length !== VAULT_KEY_BYTES) {
    throw new VaultCryptoError('authentication-failed', `${name} must be 256 bits.`);
  }
}

function newVaultIv(randomBytes: RandomBytes, name: string): Uint8Array {
  const iv = randomBytes(VAULT_IV_BYTES);
  if (iv.length !== VAULT_IV_BYTES) {
    zeroBytes(iv);
    throw new VaultCryptoError('envelope-invalid', `${name} IV must be 96 bits.`);
  }
  return iv;
}

function requireKeyMaterial(key: VaultKeyMaterial, name: string): void {
  if (key instanceof Uint8Array) {
    requireKeyLength(key, name);
    return;
  }
  if (!isAes256GcmSecretKey(key)) {
    throw new VaultCryptoError(
      'authentication-failed',
      `${name} must be a 256-bit AES-GCM secret key.`,
    );
  }
}

function isAes256GcmSecretKey(key: CryptoKey): boolean {
  return (
    key.type === 'secret' &&
    key.algorithm.name === 'AES-GCM' &&
    (key.algorithm as AesKeyAlgorithm).length === VAULT_KEY_BYTES * 8
  );
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
