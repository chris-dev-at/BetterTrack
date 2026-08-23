import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@bettertrack/contracts';
import { argon2id } from 'hash-wasm';

import { equalBytes, utf8, zeroBytes } from '../bytes';
import {
  VAULT_IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  secureRandomBytes,
  type RandomBytes,
} from '../crypto';
import { EndpointKeystoreError, asEndpointKeystoreError } from './errors';
import { decodeBase64Url, encodeBase64Url } from './encoding';
import {
  ENDPOINT_KEYSTORE_VERSION,
  ENDPOINT_PASSWORD_KDF,
  type EndpointPasswordMetadataV1,
  type WrappedPhrasePayloadV1,
} from './types';

const CHECK_AAD = utf8('bettertrack-endpoint-keystore-check-v1');
const CHECK_PLAINTEXT = utf8('bettertrack-endpoint-keystore-check-ok-v1');
const PHRASE_AAD_PREFIX = 'bettertrack-endpoint-keystore-phrase-v1:';
const BIP39_ENTROPY_BYTES = 16;
const GCM_TAG_BYTES = 16;

export interface DevicePasswordArgon2Options {
  password: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  parallelism: number;
  memorySize: number;
  hashLength: number;
  outputType: 'binary';
}

export type DevicePasswordArgon2 = (options: DevicePasswordArgon2Options) => Promise<Uint8Array>;

export interface DeviceCryptoDependencies {
  argon2?: DevicePasswordArgon2;
  randomBytes?: RandomBytes;
}

export async function createEndpointPassword(
  password: string,
  dependencies: DeviceCryptoDependencies = {},
): Promise<{ metadata: EndpointPasswordMetadataV1; deviceKey: Uint8Array }> {
  validateDevicePassword(password);
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes;
  const salt = requireRandomBytes(
    randomBytes,
    ENDPOINT_PASSWORD_KDF.saltBytes,
    'Device-password salt',
  );
  const iv = requireRandomBytes(randomBytes, VAULT_IV_BYTES, 'Device-password check IV');
  let deviceKey: Uint8Array | undefined;
  try {
    const kdf = {
      algorithm: ENDPOINT_PASSWORD_KDF.algorithm,
      memoryKiB: ENDPOINT_PASSWORD_KDF.memoryKiB,
      iterations: ENDPOINT_PASSWORD_KDF.iterations,
      parallelism: ENDPOINT_PASSWORD_KDF.parallelism,
      salt: encodeBase64Url(salt),
    } as const;
    deviceKey = await deriveDeviceKey(password, kdf, dependencies.argon2);
    const ciphertext = await aesGcmEncrypt(deviceKey, iv, CHECK_PLAINTEXT, CHECK_AAD);
    return {
      metadata: {
        version: ENDPOINT_KEYSTORE_VERSION,
        kdf,
        wrapCheck: {
          algorithm: 'A256GCM',
          iv: encodeBase64Url(iv),
          ciphertext: encodeBase64Url(ciphertext),
        },
        lockout: { failures: 0, lockedUntil: null },
      },
      deviceKey,
    };
  } catch (cause) {
    if (deviceKey != null) zeroBytes(deviceKey);
    throw asEndpointKeystoreError(
      'crypto-failed',
      'Could not configure the endpoint device password.',
      cause,
    );
  } finally {
    zeroBytes(salt);
    zeroBytes(iv);
  }
}

export async function deriveDeviceKey(
  password: string,
  kdf: EndpointPasswordMetadataV1['kdf'],
  derive: DevicePasswordArgon2 = argon2id as DevicePasswordArgon2,
): Promise<Uint8Array> {
  validateDevicePassword(password);
  const passwordBytes = utf8(password);
  const salt = decodeBase64Url(kdf.salt);
  try {
    if (salt.length !== ENDPOINT_PASSWORD_KDF.saltBytes) {
      throw new EndpointKeystoreError(
        'storage-invalid',
        'Endpoint password salt has an invalid length.',
      );
    }
    const derived = await derive({
      password: passwordBytes,
      salt,
      iterations: ENDPOINT_PASSWORD_KDF.iterations,
      parallelism: ENDPOINT_PASSWORD_KDF.parallelism,
      memorySize: ENDPOINT_PASSWORD_KDF.memoryKiB,
      hashLength: ENDPOINT_PASSWORD_KDF.keyBytes,
      outputType: 'binary',
    });
    if (derived.length !== ENDPOINT_PASSWORD_KDF.keyBytes) {
      zeroBytes(derived);
      throw new EndpointKeystoreError(
        'crypto-failed',
        'Argon2id returned an invalid device-key length.',
      );
    }
    const owned = new Uint8Array(derived);
    zeroBytes(derived);
    return owned;
  } catch (cause) {
    throw asEndpointKeystoreError(
      'crypto-failed',
      'Could not derive the endpoint device key.',
      cause,
    );
  } finally {
    zeroBytes(passwordBytes);
    zeroBytes(salt);
  }
}

export async function verifyEndpointPassword(
  metadata: EndpointPasswordMetadataV1,
  deviceKey: Uint8Array,
): Promise<boolean> {
  const iv = decodeBase64Url(metadata.wrapCheck.iv);
  const ciphertext = decodeBase64Url(metadata.wrapCheck.ciphertext);
  let plaintext: Uint8Array | undefined;
  try {
    if (
      iv.length !== VAULT_IV_BYTES ||
      ciphertext.length !== CHECK_PLAINTEXT.length + GCM_TAG_BYTES
    ) {
      throw new EndpointKeystoreError(
        'storage-invalid',
        'Endpoint password check has an invalid length.',
      );
    }
    try {
      plaintext = await aesGcmDecrypt(deviceKey, iv, ciphertext, CHECK_AAD);
    } catch {
      return false;
    }
    return equalBytes(plaintext, CHECK_PLAINTEXT);
  } finally {
    zeroBytes(iv);
    zeroBytes(ciphertext);
    if (plaintext != null) zeroBytes(plaintext);
  }
}

export async function wrapMnemonicEntropy(
  vaultId: string,
  entropy: Uint8Array,
  deviceKey: Uint8Array,
  randomBytes: RandomBytes = secureRandomBytes,
): Promise<WrappedPhrasePayloadV1> {
  if (entropy.length !== BIP39_ENTROPY_BYTES) {
    throw new EndpointKeystoreError('crypto-failed', 'BIP39 entropy must be exactly 128 bits.');
  }
  const iv = requireRandomBytes(randomBytes, VAULT_IV_BYTES, 'Phrase wrap IV');
  try {
    const ciphertext = await aesGcmEncrypt(
      deviceKey,
      iv,
      entropy,
      utf8(PHRASE_AAD_PREFIX + vaultId),
    );
    return {
      version: ENDPOINT_KEYSTORE_VERSION,
      algorithm: 'A256GCM',
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(ciphertext),
    };
  } catch (cause) {
    throw asEndpointKeystoreError('crypto-failed', 'Could not wrap the vault phrase.', cause);
  } finally {
    zeroBytes(iv);
  }
}

export async function unwrapMnemonicEntropy(
  vaultId: string,
  payload: WrappedPhrasePayloadV1,
  deviceKey: Uint8Array,
): Promise<Uint8Array> {
  const iv = decodeBase64Url(payload.iv);
  const ciphertext = decodeBase64Url(payload.ciphertext);
  try {
    if (iv.length !== VAULT_IV_BYTES || ciphertext.length !== BIP39_ENTROPY_BYTES + GCM_TAG_BYTES) {
      throw new EndpointKeystoreError('storage-invalid', 'Wrapped phrase has an invalid length.');
    }
    const entropy = await aesGcmDecrypt(
      deviceKey,
      iv,
      ciphertext,
      utf8(PHRASE_AAD_PREFIX + vaultId),
    );
    if (entropy.length !== BIP39_ENTROPY_BYTES) {
      zeroBytes(entropy);
      throw new EndpointKeystoreError('storage-invalid', 'Unwrapped phrase has an invalid length.');
    }
    return entropy;
  } catch (cause) {
    throw asEndpointKeystoreError(
      'storage-invalid',
      'Could not authenticate the stored vault phrase.',
      cause,
    );
  } finally {
    zeroBytes(iv);
    zeroBytes(ciphertext);
  }
}

function validateDevicePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new EndpointKeystoreError(
      'device-password-invalid',
      `Device password must contain ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
}

function requireRandomBytes(randomBytes: RandomBytes, length: number, name: string): Uint8Array {
  const bytes = randomBytes(length);
  if (bytes.length !== length) {
    zeroBytes(bytes);
    throw new EndpointKeystoreError('crypto-failed', `${name} has an invalid length.`);
  }
  return bytes;
}
