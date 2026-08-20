import { vaultIdParamSchema } from '@bettertrack/contracts';

import { zeroBytes } from '../bytes';
import { decodeBase64Url } from './encoding';
import { EndpointKeystoreError } from './errors';
import {
  ENDPOINT_KEYSTORE_VERSION,
  ENDPOINT_PASSWORD_KDF,
  type EndpointPasswordMetadataV1,
  type StoredPhraseEntry,
} from './types';

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const BIP39_ENTROPY_BYTES = 16;
const PASSWORD_CHECK_PLAINTEXT_BYTES = 41;

export function parseEndpointPasswordMetadata(value: unknown): EndpointPasswordMetadataV1 {
  if (!hasExactKeys(value, ['version', 'kdf', 'wrapCheck', 'lockout'])) invalidMetadata();
  const metadata = value as Record<string, unknown>;
  if (metadata.version !== ENDPOINT_KEYSTORE_VERSION) invalidMetadata();
  if (
    !hasExactKeys(metadata.kdf, ['algorithm', 'memoryKiB', 'iterations', 'parallelism', 'salt'])
  ) {
    invalidMetadata();
  }
  const kdf = metadata.kdf as Record<string, unknown>;
  if (
    kdf.algorithm !== ENDPOINT_PASSWORD_KDF.algorithm ||
    kdf.memoryKiB !== ENDPOINT_PASSWORD_KDF.memoryKiB ||
    kdf.iterations !== ENDPOINT_PASSWORD_KDF.iterations ||
    kdf.parallelism !== ENDPOINT_PASSWORD_KDF.parallelism ||
    typeof kdf.salt !== 'string'
  ) {
    invalidMetadata();
  }
  requireEncodedLength(kdf.salt, ENDPOINT_PASSWORD_KDF.saltBytes, 'password salt');

  if (!hasExactKeys(metadata.wrapCheck, ['algorithm', 'iv', 'ciphertext'])) invalidMetadata();
  const wrapCheck = metadata.wrapCheck as Record<string, unknown>;
  if (
    wrapCheck.algorithm !== 'A256GCM' ||
    typeof wrapCheck.iv !== 'string' ||
    typeof wrapCheck.ciphertext !== 'string'
  ) {
    invalidMetadata();
  }
  requireEncodedLength(wrapCheck.iv, GCM_IV_BYTES, 'password-check IV');
  requireEncodedLength(
    wrapCheck.ciphertext,
    PASSWORD_CHECK_PLAINTEXT_BYTES + GCM_TAG_BYTES,
    'password check',
  );

  if (!hasExactKeys(metadata.lockout, ['failures', 'lockedUntil'])) invalidMetadata();
  const lockout = metadata.lockout as Record<string, unknown>;
  if (!Number.isInteger(lockout.failures) || (lockout.failures as number) < 0) invalidMetadata();
  if (
    lockout.lockedUntil !== null &&
    (!Number.isInteger(lockout.lockedUntil) || (lockout.lockedUntil as number) < 0)
  ) {
    invalidMetadata();
  }
  return value as unknown as EndpointPasswordMetadataV1;
}

export function parseStoredPhraseEntry(
  value: unknown,
  expectedVaultId?: string,
): StoredPhraseEntry {
  if (!hasExactKeys(value, ['vaultId', 'custody', 'payload'])) invalidEntry();
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.vaultId !== 'string' ||
    !vaultIdParamSchema.safeParse({ vaultId: entry.vaultId }).success ||
    (expectedVaultId != null && entry.vaultId !== expectedVaultId)
  ) {
    invalidEntry();
  }
  if (entry.custody === 'wrapped') {
    if (!hasExactKeys(entry.payload, ['version', 'algorithm', 'iv', 'ciphertext'])) invalidEntry();
    const payload = entry.payload as Record<string, unknown>;
    if (
      payload.version !== ENDPOINT_KEYSTORE_VERSION ||
      payload.algorithm !== 'A256GCM' ||
      typeof payload.iv !== 'string' ||
      typeof payload.ciphertext !== 'string'
    ) {
      invalidEntry();
    }
    requireEncodedLength(payload.iv, GCM_IV_BYTES, 'phrase IV');
    requireEncodedLength(payload.ciphertext, BIP39_ENTROPY_BYTES + GCM_TAG_BYTES, 'wrapped phrase');
    return value as StoredPhraseEntry;
  }
  if (entry.custody === 'plain') {
    if (!hasExactKeys(entry.payload, ['version', 'encoding', 'entropy'])) invalidEntry();
    const payload = entry.payload as Record<string, unknown>;
    if (
      payload.version !== ENDPOINT_KEYSTORE_VERSION ||
      payload.encoding !== 'bip39-entropy-base64url' ||
      typeof payload.entropy !== 'string'
    ) {
      invalidEntry();
    }
    requireEncodedLength(payload.entropy, BIP39_ENTROPY_BYTES, 'plain phrase');
    return value as StoredPhraseEntry;
  }
  invalidEntry();
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireEncodedLength(value: string, length: number, label: string): void {
  const bytes = decodeBase64Url(value);
  try {
    if (bytes.length !== length) {
      throw new EndpointKeystoreError('storage-invalid', `Stored ${label} has an invalid length.`);
    }
  } finally {
    zeroBytes(bytes);
  }
}

function invalidMetadata(): never {
  throw new EndpointKeystoreError(
    'storage-invalid',
    'Endpoint password metadata does not match version 1.',
  );
}

function invalidEntry(): never {
  throw new EndpointKeystoreError(
    'storage-invalid',
    'Stored phrase entry does not match version 1.',
  );
}
