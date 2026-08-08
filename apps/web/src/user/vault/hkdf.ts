import { VaultCryptoError } from './errors';

/**
 * HKDF-SHA256 (RFC 5869) over WebCrypto — the r3 derivation primitive.
 *
 * Three consumers, all specified in `docs/VAULTS_V2_DESIGN.md` r3:
 *  - §18 migration content key: `HKDF(VK, "btv2-migration-v1", 32)`
 *  - §18 migration doc IVs / writer identity: `HKDF(K_c, "btv2-migration-iv" ‖ docId, 12)` …
 *  - §21 header-MAC key: `HKDF(K_c, "btv2-header-mac-v1", 32)`
 *
 * The salt defaults to EMPTY (RFC 5869 then uses a zeroed hash-length salt),
 * which is what every r3 derivation specifies — domain separation rides
 * entirely on the `info` strings.
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
