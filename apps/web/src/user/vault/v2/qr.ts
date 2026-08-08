import {
  parseVaultQrPayloadStructure,
  serializeVaultQrPayload,
  VAULT2_QR_PREFIX,
  VAULT2_QR_TTL_MS,
  type VaultQrPayload,
} from '@bettertrack/contracts';

import { base64ToBytes, bytesToBase64, decodeUtf8, utf8, zeroBytes } from '../bytes';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveVaultKek,
  generateVaultSalt,
  secureRandomBytes,
  VAULT_ARGON2_PARAMS,
  VAULT_IV_BYTES,
  type RandomBytes,
  type VaultCryptoDeps,
} from '../crypto';
import { VaultCryptoError } from '../errors';

import { normalizeQrCode } from './qrCode';
import { checkVaultPassphrase, normalizeVaultPassphrase, requireVaultPassphrase } from './words';

export { VAULT2_QR_PREFIX, VAULT2_QR_TTL_MS, type VaultQrPayload };
export {
  formatQrCode,
  generateQrCode,
  isValidQrCode,
  normalizeQrCode,
  VAULT2_QR_CODE_LENGTH,
} from './qrCode';

/**
 * Code-wrapped QR handoff (`docs/VAULTS_V2_DESIGN.md` r2 §10, hardened by r3
 * §19).
 *
 * The image carries `w = salt ‖ iv ‖ AES-GCM(Argon2id(code, salt), P)`, never
 * `P` itself — **a photograph of the QR is useless on its own**. The one-time
 * code lives on a second screen, is spoken or typed out of band, and the pair
 * only works inside the 120 s window.
 *
 * r3 §19 sized the code: a captured `w` plus its GCM tag is an offline
 * verification oracle, so the code IS the security margin. Eight Crockford
 * base32 characters are exactly 2^40 candidates; at the vault Argon2id profile
 * (64 MiB, t=3, ~0.35 s a guess) a full sweep is ≈12,000 CPU-years of
 * memory-hard work — versus ≈97 CPU-hours for the 6-digit PIN this replaced.
 * The wrap is bound to the vault id as AAD, so a `w` cannot be spliced onto
 * another vault's code.
 */

const CODE_SALT_BYTES = 16;

/** Build the QR string. The passphrase is wrapped under the code before encoding. */
export async function buildVaultQrPayload(input: {
  vaultId: string;
  name: string;
  passphrase: string;
  /** The 8-character one-time code (any Crockford-equivalent spelling). */
  code: string;
  randomBytes?: RandomBytes;
  deps?: VaultCryptoDeps;
}): Promise<string> {
  const passphrase = requireVaultPassphrase(input.passphrase);
  const code = normalizeQrCode(input.code);
  if (code == null) {
    throw new VaultCryptoError(
      'kdf-failed',
      'The handoff code must be eight Crockford base32 characters.',
    );
  }
  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const salt = generateVaultSalt(randomBytes);
  const iv = randomBytes(VAULT_IV_BYTES);
  let codeKey: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    // r3 §19: the KDF over the code is the NORMATIVE vault Argon2id profile —
    // one cost profile in the whole product, no cheaper second path.
    codeKey = await deriveVaultKek(
      code,
      { ...VAULT_ARGON2_PARAMS, salt: bytesToBase64(salt) },
      input.deps,
    );
    plaintext = utf8(passphrase);
    const ciphertext = await aesGcmEncrypt(codeKey, iv, plaintext, utf8(input.vaultId));
    const wrapped = new Uint8Array(salt.length + iv.length + ciphertext.length);
    wrapped.set(salt);
    wrapped.set(iv, salt.length);
    wrapped.set(ciphertext, salt.length + iv.length);
    return serializeVaultQrPayload({
      qr: 1,
      vaultId: input.vaultId,
      name: input.name.trim(),
      w: bytesToBase64(wrapped),
    });
  } finally {
    zeroBytes(salt);
    zeroBytes(iv);
    if (codeKey != null) zeroBytes(codeKey);
    if (plaintext != null) zeroBytes(plaintext);
  }
}

export type VaultQrParseResult =
  | { ok: true; payload: VaultQrPayload }
  | { ok: false; reason: 'prefix' | 'json' | 'shape' | 'wrapped' };

/**
 * Parse a scanned or pasted code. Never throws — a camera feeds this arbitrary
 * strings — and does NOT need the one-time code: scanning and unwrapping are
 * separate steps because the receiver scans first and is asked for the code
 * afterwards.
 */
export function parseVaultQrPayload(value: string): VaultQrParseResult {
  const structural = parseVaultQrPayloadStructure(value);
  if (!structural.ok) return structural;
  try {
    const wrapped = base64ToBytes(structural.payload.w, 'envelope-invalid');
    if (wrapped.length <= CODE_SALT_BYTES + VAULT_IV_BYTES + 16) {
      return { ok: false, reason: 'wrapped' };
    }
  } catch {
    return { ok: false, reason: 'wrapped' };
  }
  return { ok: true, payload: structural.payload };
}

export type VaultQrUnwrapResult =
  | { ok: true; passphrase: string }
  | { ok: false; reason: 'code-format' | 'code-wrong' | 'passphrase' };

/**
 * Unwrap `w` with the code the sender read out. A wrong code and a corrupted
 * `w` both surface as `code-wrong`: the receiver cannot use this to learn
 * whether the image itself was valid.
 */
export async function unwrapVaultQrPayload(
  payload: VaultQrPayload,
  code: string,
  deps?: VaultCryptoDeps,
): Promise<VaultQrUnwrapResult> {
  const canonical = normalizeQrCode(code);
  if (canonical == null) return { ok: false, reason: 'code-format' };
  let wrapped: Uint8Array | undefined;
  let codeKey: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    wrapped = base64ToBytes(payload.w, 'envelope-invalid');
    if (wrapped.length <= CODE_SALT_BYTES + VAULT_IV_BYTES + 16) {
      return { ok: false, reason: 'code-wrong' };
    }
    codeKey = await deriveVaultKek(
      canonical,
      {
        ...VAULT_ARGON2_PARAMS,
        salt: bytesToBase64(wrapped.subarray(0, CODE_SALT_BYTES)),
      },
      deps,
    );
    plaintext = await aesGcmDecrypt(
      codeKey,
      wrapped.subarray(CODE_SALT_BYTES, CODE_SALT_BYTES + VAULT_IV_BYTES),
      wrapped.subarray(CODE_SALT_BYTES + VAULT_IV_BYTES),
      utf8(payload.vaultId),
    );
    const passphrase = normalizeVaultPassphrase(decodeUtf8(plaintext, 'document-invalid'));
    if (!checkVaultPassphrase(passphrase).valid) return { ok: false, reason: 'passphrase' };
    return { ok: true, passphrase };
  } catch {
    return { ok: false, reason: 'code-wrong' };
  } finally {
    if (wrapped != null) zeroBytes(wrapped);
    if (codeKey != null) zeroBytes(codeKey);
    if (plaintext != null) zeroBytes(plaintext);
  }
}
