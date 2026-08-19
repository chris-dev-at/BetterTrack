import { VaultCryptoError } from './errors';

/**
 * HKDF-SHA256 (RFC 5869) over WebCrypto.
 *
 * CURRENTLY UNUSED IN PRODUCTION. Its only three consumers — the vault-v2
 * migration content key, the migration document IVs, and the v2 header-MAC key
 * — went away with the per-portfolio vault v2 surface (owner ruling 2026-08-19,
 * PROJECTPLAN §16). The primitive is kept, with its conformance test, because it
 * is a correct standalone RFC 5869 implementation and deleting working vault
 * crypto is not something to do as a side effect of removing a feature.
 *
 * The salt defaults to EMPTY (RFC 5869 then uses a zeroed hash-length salt) —
 * domain separation rides entirely on the `info` strings, so any future consumer
 * must pick an `info` nobody else uses.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
  salt: Uint8Array = new Uint8Array(0),
): Promise<Uint8Array> {
  if (ikm.length === 0) {
    throw new VaultCryptoError('kdf-failed', 'HKDF input key material must be non-empty.');
  }
  if (!Number.isInteger(length) || length <= 0 || length > 255 * 32) {
    throw new VaultCryptoError('kdf-failed', 'HKDF output length is out of range.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle == null) {
    throw new VaultCryptoError('unsupported-crypto', 'WebCrypto HKDF is unavailable.');
  }
  try {
    const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      key,
      length * 8,
    );
    return new Uint8Array(bits);
  } catch (cause) {
    throw new VaultCryptoError('kdf-failed', 'HKDF-SHA256 derivation failed.', { cause });
  }
}

/**
 * Force 16 bytes into RFC 4122 shape (version 4, variant 10) and format them.
 * Used by the §18 migration derivations, where "uuid" fields must be
 * deterministic yet still satisfy every uuid-shaped validator in the stack.
 */
export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new VaultCryptoError('kdf-failed', 'A derived uuid needs exactly 16 bytes.');
  }
  const copy = bytes.slice();
  copy[6] = ((copy[6] ?? 0) & 0x0f) | 0x40;
  copy[8] = ((copy[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...copy].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
