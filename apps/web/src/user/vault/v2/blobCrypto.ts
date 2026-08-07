import {
  VAULT_MAGIC,
  VAULT2_BLOB_FORMAT_VERSION,
  VAULT2_DOCUMENT_VERSION,
  vaultBlobHeaderSchema,
  vaultContentDocSchema,
  type VaultBlobHeader,
  type VaultContentDoc,
} from '@bettertrack/contracts';
import { deflateSync, inflateSync } from 'fflate';

import { base64ToBytes, bytesToBase64, decodeUtf8, utf8, zeroBytes } from '../bytes';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  secureRandomBytes,
  VAULT_IV_BYTES,
  type RandomBytes,
  type VaultKeyMaterial,
} from '../crypto';
import { asVaultCryptoError, VaultCryptoError } from '../errors';

/**
 * Per-portfolio content blobs (`docs/VAULTS_V2_DESIGN.md` §2).
 *
 * The wire shape is the proven v1 envelope — `BTVAULT1` magic, a 4-byte
 * big-endian header length, a UTF-8 JSON header, then the ciphertext — with the
 * header's `formatVersion` bumped to 2. Keeping the magic means a v1 reader
 * reaches its existing `update-required` branch rather than "corrupt bytes",
 * which is the difference between a user seeing "update the app" and a user
 * seeing a scary integrity error.
 *
 * The exact header bytes are AES-GCM additional authenticated data, so the
 * vault id, the portfolio id, the CAS version and the doc kind are all bound to
 * the ciphertext: a blob cannot be replayed into another portfolio or another
 * vault, and its version cannot be rolled back in place.
 */

const MAGIC_BYTES = utf8(VAULT_MAGIC);
const PREFIX_BYTES = MAGIC_BYTES.length + 4;
const AES_GCM_TAG_BYTES = 16;

export interface EncryptVaultBlobInput {
  document: VaultContentDoc;
  contentKey: VaultKeyMaterial;
  blobVersion: number;
  deviceId: string;
  writeId: string;
  writtenAt: string;
  randomBytes?: RandomBytes;
}

export interface EncryptedVaultBlob {
  envelope: Uint8Array;
  header: VaultBlobHeader;
}

/** Serialize a blob header canonically; these bytes are the GCM AAD. */
export function serializeBlobHeader(header: VaultBlobHeader): Uint8Array {
  const parsed = vaultBlobHeaderSchema.parse(header);
  return utf8(
    JSON.stringify({
      formatVersion: parsed.formatVersion,
      cipher: parsed.cipher,
      iv: parsed.iv,
      vaultId: parsed.vaultId,
      docKind: parsed.docKind,
      portfolioId: parsed.portfolioId,
      schemaVersion: parsed.schemaVersion,
      blobVersion: parsed.blobVersion,
      deviceId: parsed.deviceId,
      writeId: parsed.writeId,
      writtenAt: parsed.writtenAt,
    }),
  );
}

export function encodeVaultBlob(header: VaultBlobHeader, ciphertext: Uint8Array): Uint8Array {
  const headerBytes = serializeBlobHeader(header);
  const output = new Uint8Array(PREFIX_BYTES + headerBytes.length + ciphertext.length);
  output.set(MAGIC_BYTES);
  new DataView(output.buffer).setUint32(MAGIC_BYTES.length, headerBytes.length, false);
  output.set(headerBytes, PREFIX_BYTES);
  output.set(ciphertext, PREFIX_BYTES + headerBytes.length);
  return output;
}

export interface DecodedVaultBlob {
  header: VaultBlobHeader;
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Split a blob without decrypting. The returned `headerBytes` are the exact
 * wire bytes, not a re-serialization: another conforming producer may order
 * members differently and its AAD must still verify.
 */
export function decodeVaultBlob(bytes: Uint8Array): DecodedVaultBlob {
  if (bytes.length <= PREFIX_BYTES) {
    throw new VaultCryptoError('envelope-invalid', 'Vault blob is truncated.');
  }
  for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
    if (bytes[index] !== MAGIC_BYTES[index]) {
      throw new VaultCryptoError('envelope-invalid', 'Vault blob has an invalid magic prefix.');
    }
  }

  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    MAGIC_BYTES.length,
    false,
  );
  const headerEnd = PREFIX_BYTES + headerLength;
  if (
    headerLength === 0 ||
    headerEnd > bytes.length ||
    bytes.length - headerEnd < AES_GCM_TAG_BYTES
  ) {
    throw new VaultCryptoError('envelope-invalid', 'Vault blob has an invalid structural length.');
  }

  const headerBytes = bytes.slice(PREFIX_BYTES, headerEnd);
  let raw: unknown;
  try {
    raw = JSON.parse(decodeUtf8(headerBytes, 'envelope-invalid'));
  } catch (cause) {
    if (cause instanceof VaultCryptoError) throw cause;
    throw new VaultCryptoError('envelope-invalid', 'Vault blob header is not valid JSON.', {
      cause,
    });
  }

  const formatVersion = (raw as { formatVersion?: unknown } | null)?.formatVersion;
  if (typeof formatVersion === 'number' && formatVersion > VAULT2_BLOB_FORMAT_VERSION) {
    throw new VaultCryptoError('update-required', 'This vault blob needs a newer app version.');
  }

  const parsed = vaultBlobHeaderSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'Vault blob header does not match the contract.',
    );
  }
  return { header: parsed.data, headerBytes, ciphertext: bytes.slice(headerEnd) };
}

/** Read a blob's cleartext version/identity without holding the content key. */
export function inspectVaultBlob(bytes: Uint8Array): VaultBlobHeader {
  return decodeVaultBlob(bytes).header;
}

export async function encryptVaultBlob(input: EncryptVaultBlobInput): Promise<EncryptedVaultBlob> {
  const document = vaultContentDocSchema.parse(input.document);
  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const iv = randomBytes(VAULT_IV_BYTES);
  if (iv.length !== VAULT_IV_BYTES) {
    throw new VaultCryptoError('envelope-invalid', 'Vault blob IV must be 96 bits.');
  }

  let plaintext: Uint8Array | undefined;
  let compressed: Uint8Array | undefined;
  try {
    const header = vaultBlobHeaderSchema.parse({
      formatVersion: VAULT2_BLOB_FORMAT_VERSION,
      cipher: 'A256GCM',
      iv: bytesToBase64(iv),
      vaultId: document.vaultId,
      docKind: document.docKind,
      portfolioId: document.docKind === 'portfolio' ? document.portfolioId : null,
      schemaVersion: VAULT2_DOCUMENT_VERSION,
      blobVersion: input.blobVersion,
      deviceId: input.deviceId,
      writeId: input.writeId,
      writtenAt: input.writtenAt,
    });
    const headerBytes = serializeBlobHeader(header);
    plaintext = utf8(JSON.stringify(document));
    compressed = deflateSync(plaintext);
    const ciphertext = await aesGcmEncrypt(input.contentKey, iv, compressed, headerBytes);
    return { header, envelope: encodeVaultBlob(header, ciphertext) };
  } catch (cause) {
    throw asVaultCryptoError('authentication-failed', 'Could not encrypt the vault blob.', cause);
  } finally {
    zeroBytes(iv);
    if (plaintext != null) zeroBytes(plaintext);
    if (compressed != null) zeroBytes(compressed);
  }
}

export async function decryptVaultBlob(
  envelope: Uint8Array,
  contentKey: VaultKeyMaterial,
): Promise<{ document: VaultContentDoc; header: VaultBlobHeader }> {
  const decoded = decodeVaultBlob(envelope);
  let iv: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    iv = base64ToBytes(decoded.header.iv, 'envelope-invalid');
    if (iv.length !== VAULT_IV_BYTES) {
      throw new VaultCryptoError('envelope-invalid', 'Vault blob IV has an invalid length.');
    }
    const compressed = await aesGcmDecrypt(contentKey, iv, decoded.ciphertext, decoded.headerBytes);
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
      throw new VaultCryptoError('document-invalid', 'Vault blob document is not valid JSON.', {
        cause,
      });
    }

    const parsed = vaultContentDocSchema.safeParse(value);
    if (!parsed.success) {
      throw new VaultCryptoError(
        'document-invalid',
        'Vault blob document does not match its schema.',
      );
    }
    // The header is authenticated, so a mismatch here means a producer bug
    // rather than tampering — still fail closed: routing a document under the
    // wrong portfolio id would merge one portfolio's rows into another.
    if (parsed.data.vaultId !== decoded.header.vaultId) {
      throw new VaultCryptoError('document-invalid', 'Vault blob document has the wrong vault id.');
    }
    if (
      parsed.data.docKind !== decoded.header.docKind ||
      (parsed.data.docKind === 'portfolio' &&
        parsed.data.portfolioId !== decoded.header.portfolioId)
    ) {
      throw new VaultCryptoError(
        'document-invalid',
        'Vault blob document does not match its authenticated identity.',
      );
    }
    return { document: parsed.data, header: decoded.header };
  } catch (cause) {
    if (cause instanceof VaultCryptoError && cause.code !== 'authentication-failed') throw cause;
    throw asVaultCryptoError(
      'authentication-failed',
      'Could not authenticate and decrypt the vault blob.',
      cause,
    );
  } finally {
    if (iv != null) zeroBytes(iv);
    if (plaintext != null) zeroBytes(plaintext);
  }
}
