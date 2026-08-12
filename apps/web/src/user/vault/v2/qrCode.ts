import {
  VAULT2_QR_CODE_ALPHABET,
  VAULT2_QR_CODE_BITS,
  VAULT2_QR_CODE_LENGTH,
} from '@bettertrack/contracts';

import { secureRandomBytes, type RandomBytes } from '../crypto';
import { VaultCryptoError } from '../errors';

/**
 * The QR handoff's one-time code (`docs/VAULTS_V2_DESIGN.md` r3 §19).
 *
 * r2 §10 specified a 6-digit PIN (~20 bits) — with `w` and its GCM tag in the
 * photographed QR as an offline verification oracle, a full sweep costs about
 * 97 CPU-hours at the vault Argon2id profile. r3 replaces it with **8
 * characters of Crockford base32: exactly 40 bits**, pushing the same sweep to
 * ≈12,000 CPU-years of memory-hard work.
 *
 * Crockford base32 because humans read it aloud and type it: no I, L, O, U in
 * the alphabet, and decoding forgives the classic confusions (`I`/`L` → `1`,
 * `O` → `0`) plus case and separators. The alphabet/length/bits constants live
 * in `@bettertrack/contracts` — mobile pins the same values.
 */

export { VAULT2_QR_CODE_ALPHABET, VAULT2_QR_CODE_BITS, VAULT2_QR_CODE_LENGTH };

const CODE_BYTES = VAULT2_QR_CODE_BITS / 8;

/**
 * Draw a uniformly random 8-character code. 40 random bits map bijectively
 * onto eight 5-bit alphabet indices — no modulo, no rejection, no bias.
 */
export function generateQrCode(randomBytes: RandomBytes = secureRandomBytes): string {
  const bytes = randomBytes(CODE_BYTES);
  if (bytes.length !== CODE_BYTES) {
    throw new VaultCryptoError('unsupported-crypto', 'The QR code needs 40 random bits.');
  }
  let acc = 0;
  let accBits = 0;
  let code = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    accBits += 8;
    while (accBits >= 5) {
      accBits -= 5;
      code += VAULT2_QR_CODE_ALPHABET[(acc >> accBits) & 0x1f]!;
    }
  }
  return code;
}

/** `XXXX-XXXX` — how the reveal screen displays a code. */
export function formatQrCode(code: string): string {
  const canonical = normalizeQrCode(code);
  if (canonical == null) {
    throw new VaultCryptoError('kdf-failed', 'Not a valid handoff code.');
  }
  return `${canonical.slice(0, 4)}-${canonical.slice(4)}`;
}

/**
 * Canonicalize typed input per Crockford: uppercase, strip separators and
 * whitespace, map `I`/`L` → `1` and `O` → `0`. Returns `null` when the result
 * is not exactly 8 alphabet characters — the KDF must only ever see the
 * canonical form, or the same code would derive different keys.
 */
export function normalizeQrCode(value: string): string | null {
  const canonical = value
    .toUpperCase()
    .replace(/[\s-]/gu, '')
    .replace(/I|L/gu, '1')
    .replace(/O/gu, '0');
  if (canonical.length !== VAULT2_QR_CODE_LENGTH) return null;
  for (const char of canonical) {
    if (!VAULT2_QR_CODE_ALPHABET.includes(char)) return null;
  }
  return canonical;
}

export function isValidQrCode(value: string): boolean {
  return normalizeQrCode(value) != null;
}
