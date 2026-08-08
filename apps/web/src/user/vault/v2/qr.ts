import {
  parseVaultQrPayloadStructure,
  serializeVaultQrPayload,
  VAULT2_QR_PIN_LENGTH,
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

import { checkVaultPassphrase, normalizeVaultPassphrase, requireVaultPassphrase } from './words';

export { VAULT2_QR_PIN_LENGTH, VAULT2_QR_PREFIX, VAULT2_QR_TTL_MS, type VaultQrPayload };

/**
 * PIN-wrapped QR handoff (`docs/VAULTS_V2_DESIGN.md` r2 §10).
 *
 * The code carries `w = salt ‖ iv ‖ AES-GCM(Argon2id(pin, salt), P)`, never `P`
 * itself. That is the whole point of r2's change: **a photograph of the code is
 * useless**. The 6-digit PIN lives on a second screen, is spoken or typed out of
 * band, and the pair only works inside the 120 s window.
 *
 * A 6-digit PIN is only ~20 bits, so it is deliberately stretched with the same
 * Argon2id profile as a vault passphrase (64 MiB, t=3). An attacker who
 * photographs the code still needs ~10^6 Argon2id evaluations at roughly half a
 * second each — days of GPU-unfriendly work for a secret whose window closed
 * two minutes after it opened. The wrap is also bound to the vault id as AAD, so
 * a `w` cannot be spliced onto another vault's code.
 */

const PIN_SALT_BYTES = 16;

/** A uniformly random 6-digit PIN, drawn without modulo bias. */
export function generateQrPin(randomBytes: RandomBytes = secureRandomBytes): string {
  const ceiling = 10 ** VAULT2_QR_PIN_LENGTH;
  // 2^32 is not a multiple of 10^6, so reject the unfair tail rather than
  // skewing the low digits.
  const limit = Math.floor(0xffffffff / ceiling) * ceiling;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const bytes = randomBytes(4);
    const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    if (value < limit) return String(value % ceiling).padStart(VAULT2_QR_PIN_LENGTH, '0');
  }
  throw new VaultCryptoError('unsupported-crypto', 'Could not draw an unbiased PIN.');
}

export function isValidQrPin(pin: string): boolean {
  return new RegExp(`^\\d{${VAULT2_QR_PIN_LENGTH}}$`, 'u').test(pin.trim());
}

/** Build the QR string. The passphrase is wrapped under the PIN before encoding. */
export async function buildVaultQrPayload(input: {
  vaultId: string;
  name: string;
  passphrase: string;
  pin: string;
  randomBytes?: RandomBytes;
  deps?: VaultCryptoDeps;
}): Promise<string> {
  const passphrase = requireVaultPassphrase(input.passphrase);
  if (!isValidQrPin(input.pin)) {
    throw new VaultCryptoError('kdf-failed', 'The handoff PIN must be six digits.');
  }
  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const salt = generateVaultSalt(randomBytes);
  const iv = randomBytes(VAULT_IV_BYTES);
  let pinKey: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    pinKey = await deriveVaultKek(
      input.pin.trim(),
      { ...VAULT_ARGON2_PARAMS, salt: bytesToBase64(salt) },
      input.deps,
    );
    plaintext = utf8(passphrase);
    const ciphertext = await aesGcmEncrypt(pinKey, iv, plaintext, utf8(input.vaultId));
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
    if (pinKey != null) zeroBytes(pinKey);
    if (plaintext != null) zeroBytes(plaintext);
  }
}

export type VaultQrParseResult =
  | { ok: true; payload: VaultQrPayload }
  | { ok: false; reason: 'prefix' | 'json' | 'shape' | 'wrapped' };

/**
 * Parse a scanned or pasted code. Never throws — a camera feeds this arbitrary
 * strings — and does NOT need the PIN: scanning and unwrapping are separate
 * steps because the receiver scans first and is asked for the PIN afterwards.
 */
export function parseVaultQrPayload(value: string): VaultQrParseResult {
  const structural = parseVaultQrPayloadStructure(value);
  if (!structural.ok) return structural;
  try {
    const wrapped = base64ToBytes(structural.payload.w, 'envelope-invalid');
    if (wrapped.length <= PIN_SALT_BYTES + VAULT_IV_BYTES + 16) {
      return { ok: false, reason: 'wrapped' };
    }
  } catch {
    return { ok: false, reason: 'wrapped' };
  }
  return { ok: true, payload: structural.payload };
}

export type VaultQrUnwrapResult =
  | { ok: true; passphrase: string }
  | { ok: false; reason: 'pin-format' | 'pin-wrong' | 'passphrase' };

/**
 * Unwrap `w` with the PIN the sender read out. A wrong PIN and a corrupted `w`
 * both surface as `pin-wrong`: the receiver cannot use this to learn whether
 * the code itself was valid.
 */
export async function unwrapVaultQrPayload(
  payload: VaultQrPayload,
  pin: string,
  deps?: VaultCryptoDeps,
): Promise<VaultQrUnwrapResult> {
  if (!isValidQrPin(pin)) return { ok: false, reason: 'pin-format' };
  let wrapped: Uint8Array | undefined;
  let pinKey: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    wrapped = base64ToBytes(payload.w, 'envelope-invalid');
    if (wrapped.length <= PIN_SALT_BYTES + VAULT_IV_BYTES + 16) {
      return { ok: false, reason: 'pin-wrong' };
    }
    pinKey = await deriveVaultKek(
      pin.trim(),
      {
        ...VAULT_ARGON2_PARAMS,
        salt: bytesToBase64(wrapped.subarray(0, PIN_SALT_BYTES)),
      },
      deps,
    );
    plaintext = await aesGcmDecrypt(
      pinKey,
      wrapped.subarray(PIN_SALT_BYTES, PIN_SALT_BYTES + VAULT_IV_BYTES),
      wrapped.subarray(PIN_SALT_BYTES + VAULT_IV_BYTES),
      utf8(payload.vaultId),
    );
    const passphrase = normalizeVaultPassphrase(decodeUtf8(plaintext, 'document-invalid'));
    if (!checkVaultPassphrase(passphrase).valid) return { ok: false, reason: 'passphrase' };
    return { ok: true, passphrase };
  } catch {
    return { ok: false, reason: 'pin-wrong' };
  } finally {
    if (wrapped != null) zeroBytes(wrapped);
    if (pinKey != null) zeroBytes(pinKey);
    if (plaintext != null) zeroBytes(plaintext);
  }
}
