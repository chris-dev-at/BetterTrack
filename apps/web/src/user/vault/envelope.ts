import {
  VAULT_DOCUMENT_VERSION,
  VAULT_FORMAT_VERSION,
  VAULT_MAGIC,
  type VaultEnvelopeHeader,
  vaultEnvelopeHeaderSchema,
} from '@bettertrack/contracts';

import { decodeUtf8, utf8 } from './bytes';
import { VaultCryptoError } from './errors';

const MAGIC_BYTES = utf8(VAULT_MAGIC);
const PREFIX_BYTES = MAGIC_BYTES.length + 4;
const AES_GCM_TAG_BYTES = 16;
const HEADER_FIELDS = new Set([
  'formatVersion',
  'cipher',
  'iv',
  'keyId',
  'wrappedKeys',
  'vaultVersion',
  'schemaVersion',
  'deviceId',
  'writeId',
  'writtenAt',
]);
const WRAPPED_KEY_FIELDS = new Set(['keyId', 'kdf', 'wrappedVk']);
const KDF_FIELDS = new Set(['alg', 'm', 't', 'p', 'salt']);

export interface DecodedEnvelope {
  header: VaultEnvelopeHeader;
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
}

export type EnvelopeVersionResult =
  | { status: 'supported'; envelope: DecodedEnvelope }
  | { status: 'update-required'; formatVersion: number; schemaVersion: number };

/**
 * Canonically serializes headers produced by this client. The exact returned bytes
 * are authenticated as AES-GCM additional data.
 */
export function serializeVaultHeader(header: VaultEnvelopeHeader): Uint8Array {
  const parsed = vaultEnvelopeHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'Vault header does not match the envelope contract.',
    );
  }
  return utf8(JSON.stringify(parsed.data));
}

export function encodeVaultEnvelope(
  header: VaultEnvelopeHeader,
  ciphertext: Uint8Array,
): Uint8Array {
  const headerBytes = serializeVaultHeader(header);
  const output = new Uint8Array(PREFIX_BYTES + headerBytes.length + ciphertext.length);
  output.set(MAGIC_BYTES);
  new DataView(output.buffer).setUint32(MAGIC_BYTES.length, headerBytes.length, false);
  output.set(headerBytes, PREFIX_BYTES);
  output.set(ciphertext, PREFIX_BYTES + headerBytes.length);
  return output;
}

export function decodeVaultEnvelope(bytes: Uint8Array): DecodedEnvelope {
  if (bytes.length <= PREFIX_BYTES) {
    throw new VaultCryptoError('envelope-invalid', 'Vault envelope is truncated.');
  }
  for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
    if (bytes[index] !== MAGIC_BYTES[index]) {
      throw new VaultCryptoError('envelope-invalid', 'Vault envelope has an invalid magic prefix.');
    }
  }

  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    MAGIC_BYTES.length,
    false,
  );
  const headerStart = PREFIX_BYTES;
  const headerEnd = headerStart + headerLength;
  if (
    headerLength === 0 ||
    headerEnd > bytes.length ||
    bytes.length - headerEnd < AES_GCM_TAG_BYTES
  ) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'Vault envelope has an invalid structural length.',
    );
  }

  const headerBytes = bytes.slice(headerStart, headerEnd);
  let untrustedHeader: unknown;
  try {
    untrustedHeader = JSON.parse(decodeUtf8(headerBytes, 'envelope-invalid'));
  } catch (cause) {
    if (cause instanceof VaultCryptoError) throw cause;
    throw new VaultCryptoError('envelope-invalid', 'Vault envelope header is not valid JSON.', {
      cause,
    });
  }

  const version = readVersions(untrustedHeader);
  if (
    version != null &&
    (version.formatVersion > VAULT_FORMAT_VERSION || version.schemaVersion > VAULT_DOCUMENT_VERSION)
  ) {
    throw new VaultCryptoError('update-required', 'This vault was written by a newer app version.');
  }

  const parsed = exactHeaderShape(untrustedHeader)
    ? vaultEnvelopeHeaderSchema.safeParse(untrustedHeader)
    : { success: false as const };
  if (!parsed.success) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'Vault envelope header does not match the contract.',
    );
  }

  // The wire header is AES-GCM additional authenticated data. Validate its parsed
  // shape, but preserve its exact serialized bytes: contract producers may use a
  // different valid JSON member order than this client's canonical encoder.
  return { header: parsed.data, headerBytes, ciphertext: bytes.slice(headerEnd) };
}

/** Read only versions to let callers display a non-destructive update-required state. */
export function inspectVaultEnvelope(bytes: Uint8Array): EnvelopeVersionResult {
  const decoded = decodeUnvalidatedEnvelope(bytes);
  const versions = readVersions(decoded.header);
  if (versions == null) {
    throw new VaultCryptoError('envelope-invalid', 'Vault envelope has no valid version fields.');
  }
  if (
    versions.formatVersion > VAULT_FORMAT_VERSION ||
    versions.schemaVersion > VAULT_DOCUMENT_VERSION
  ) {
    return { status: 'update-required', ...versions };
  }
  return { status: 'supported', envelope: decodeVaultEnvelope(bytes) };
}

function decodeUnvalidatedEnvelope(bytes: Uint8Array): { header: unknown } {
  if (bytes.length <= PREFIX_BYTES) {
    throw new VaultCryptoError('envelope-invalid', 'Vault envelope is truncated.');
  }
  for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
    if (bytes[index] !== MAGIC_BYTES[index]) {
      throw new VaultCryptoError('envelope-invalid', 'Vault envelope has an invalid magic prefix.');
    }
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    MAGIC_BYTES.length,
    false,
  );
  const headerEnd = PREFIX_BYTES + headerLength;
  if (headerLength === 0 || headerEnd >= bytes.length) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'Vault envelope has an invalid structural length.',
    );
  }
  try {
    return {
      header: JSON.parse(decodeUtf8(bytes.subarray(PREFIX_BYTES, headerEnd), 'envelope-invalid')),
    };
  } catch (cause) {
    if (cause instanceof VaultCryptoError) throw cause;
    throw new VaultCryptoError('envelope-invalid', 'Vault envelope header is not valid JSON.', {
      cause,
    });
  }
}

function readVersions(value: unknown): { formatVersion: number; schemaVersion: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const header = value as Record<string, unknown>;
  return Number.isInteger(header.formatVersion) && Number.isInteger(header.schemaVersion)
    ? {
        formatVersion: header.formatVersion as number,
        schemaVersion: header.schemaVersion as number,
      }
    : null;
}

function exactHeaderShape(value: unknown): boolean {
  if (!hasOnlyFields(value, HEADER_FIELDS)) return false;
  const wrappedKeys = (value as Record<string, unknown>).wrappedKeys;
  if (!Array.isArray(wrappedKeys)) return false;
  return wrappedKeys.every((wrappedKey) => {
    if (!hasOnlyFields(wrappedKey, WRAPPED_KEY_FIELDS)) return false;
    return hasOnlyFields((wrappedKey as Record<string, unknown>).kdf, KDF_FIELDS);
  });
}

function hasOnlyFields(
  value: unknown,
  fields: ReadonlySet<string>,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.has(key))
  );
}
