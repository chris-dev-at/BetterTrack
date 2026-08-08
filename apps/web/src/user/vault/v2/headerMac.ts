import {
  VAULT2_HEADER_MAC_INFO,
  vaultHeaderMacSchema,
  type VaultHeaderDoc,
  type VaultHeaderMac,
} from '@bettertrack/contracts';

import { base64ToBytes, bytesToBase64, utf8, zeroBytes } from '../bytes';
import { canonicalVaultJson } from '../canonicalJson';
import { VaultCryptoError } from '../errors';
import { hkdfSha256 } from '../hkdf';

/**
 * The r3 §21 header integrity tag — closing the gap r2 §9 recorded when it
 * withdrew the fixed-nonce GMAC seal.
 *
 * `mac = { v: 1, tag: base64(HMAC-SHA256(K_mac, canonicalHeaderBytes)) }`
 * `K_mac = HKDF-SHA256(salt = empty, IKM = K_c, info = "btv2-header-mac-v1")`
 *
 * `canonicalHeaderBytes` is the UTF-8 canonical JSON (sorted keys at every
 * level, no whitespace — the same serialization the §4 merge tie-breaks use)
 * of the header object with the `mac` member removed. Unknown members are
 * INCLUDED: a client that preserves a field it does not understand also
 * authenticates it, so preservation cannot become a laundering channel.
 *
 * Why HMAC and not GCM/GMAC: the header is rewritten on every index change, so
 * the tag key authenticates many messages over its life. HMAC is deterministic
 * and safe under unbounded key reuse; a fixed-nonce GMAC leaks its
 * authentication subkey on the second message, which is exactly why the r2
 * draft was withdrawn.
 *
 * What the tag CANNOT do: replay protection. A complete older `(header, mac)`
 * pair verifies as its old content — `headerVersion` is inside the
 * authenticated bytes precisely so the transport CAS stays the rollback
 * defence.
 */

export type VaultHeaderSealState = 'verified' | 'unsealed';

const HMAC_PARAMS = { name: 'HMAC', hash: 'SHA-256' } as const;

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (subtle == null) {
    throw new VaultCryptoError('unsupported-crypto', 'WebCrypto HMAC is unavailable.');
  }
  return subtle;
}

/** The exact bytes the tag authenticates: the header minus `mac`, canonical. */
export function headerMacInputBytes(header: VaultHeaderDoc): Uint8Array {
  const { mac: _mac, ...unsealed } = header as VaultHeaderDoc & Record<string, unknown>;
  return utf8(canonicalVaultJson(unsealed));
}

export async function deriveHeaderMacKey(contentKey: Uint8Array): Promise<Uint8Array> {
  return hkdfSha256(contentKey, utf8(VAULT2_HEADER_MAC_INFO), 32);
}

export async function computeHeaderMac(
  header: VaultHeaderDoc,
  contentKey: Uint8Array,
): Promise<VaultHeaderMac> {
  const subtle = requireSubtle();
  let macKey: Uint8Array | undefined;
  try {
    macKey = await deriveHeaderMacKey(contentKey);
    const key = await subtle.importKey('raw', macKey, HMAC_PARAMS, false, ['sign']);
    const tag = new Uint8Array(await subtle.sign('HMAC', key, headerMacInputBytes(header)));
    return { v: 1, tag: bytesToBase64(tag) };
  } finally {
    if (macKey != null) zeroBytes(macKey);
  }
}

/** Return the header with a freshly computed r3 §21 tag attached. */
export async function attachHeaderMac(
  header: VaultHeaderDoc,
  contentKey: Uint8Array,
): Promise<VaultHeaderDoc> {
  return { ...header, mac: await computeHeaderMac(header, contentKey) };
}

/**
 * Verify a header's tag under the vault content key.
 *
 * - absent tag       → `'unsealed'` (tolerated this arc; upgrade-on-write)
 * - valid tag        → `'verified'`
 * - INVALID tag      → throws `authentication-failed`, fail closed: a wrong tag
 *   is indistinguishable from a blob store that relabelled, added or dropped
 *   an index entry, and silently ignoring it would make the tag decorative.
 *
 * The comparison rides `SubtleCrypto.verify`, not a byte loop, so it is not a
 * timing oracle for the tag.
 */
export async function verifyHeaderMac(
  header: VaultHeaderDoc,
  contentKey: Uint8Array,
): Promise<VaultHeaderSealState> {
  if (header.mac === undefined) return 'unsealed';
  const parsed = vaultHeaderMacSchema.safeParse(header.mac);
  if (!parsed.success) {
    throw new VaultCryptoError(
      'authentication-failed',
      'The vault header integrity tag is malformed.',
    );
  }
  const subtle = requireSubtle();
  let macKey: Uint8Array | undefined;
  let tag: Uint8Array | undefined;
  try {
    try {
      tag = base64ToBytes(parsed.data.tag, 'envelope-invalid');
    } catch (cause) {
      throw new VaultCryptoError(
        'authentication-failed',
        'The vault header integrity tag is not valid base64.',
        { cause },
      );
    }
    macKey = await deriveHeaderMacKey(contentKey);
    const key = await subtle.importKey('raw', macKey, HMAC_PARAMS, false, ['verify']);
    const valid = await subtle.verify('HMAC', key, tag, headerMacInputBytes(header));
    if (!valid) {
      throw new VaultCryptoError(
        'authentication-failed',
        'The vault header failed integrity verification.',
      );
    }
    return 'verified';
  } finally {
    if (macKey != null) zeroBytes(macKey);
    if (tag != null) zeroBytes(tag);
  }
}
