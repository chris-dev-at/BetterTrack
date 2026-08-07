import {
  canonicalSealedHeaderBytes,
  VAULT2_HEADER_FORMAT_VERSION,
  vaultHeaderDocSchema,
  type VaultBackendSet,
  type VaultHeaderDoc,
  type VaultKdfParams,
  type VaultKeySlot,
  type VaultPortfolioIndexEntry,
} from '@bettertrack/contracts';

import { base64ToBytes, bytesToBase64, utf8, zeroBytes } from '../bytes';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveVaultKek,
  generateVaultKey,
  generateVaultSalt,
  secureRandomBytes,
  VAULT_ARGON2_PARAMS,
  VAULT_IV_BYTES,
  VAULT_KEY_BYTES,
  type RandomBytes,
  type VaultCryptoDeps,
} from '../crypto';
import { asVaultCryptoError, VaultCryptoError } from '../errors';

import { requireVaultPassphrase } from './words';

/**
 * Vault header build/open (`docs/VAULTS_V2_DESIGN.md` §2).
 *
 * ```
 * 12 words P ──Argon2id(P, vault.kdfSalt)──► KEK ──unwraps keySlots[0]──► K_c
 * ```
 *
 * `K_c` is a fresh random 256-bit content key; the passphrase never encrypts
 * content directly, which is what lets a passphrase change rewrite one small
 * header instead of every portfolio blob.
 */

/** Sealed-empty-plaintext GCM tag length; the seal carries no ciphertext. */
const SEAL_TAG_BYTES = 16;

export interface BuildVaultHeaderInput {
  vaultId: string;
  name: string;
  backends: VaultBackendSet;
  passphrase: string;
  portfolios?: VaultPortfolioIndexEntry[];
  deviceId: string;
  writeId: string;
  writtenAt: string;
  /** Test seam only; production always uses the WebCrypto CSPRNG. */
  randomBytes?: RandomBytes;
  deps?: VaultCryptoDeps;
}

export interface BuiltVaultHeader {
  header: VaultHeaderDoc;
  /** The freshly generated content key. The caller owns zeroing it. */
  contentKey: Uint8Array;
}

/** Argon2id parameters for a vault: the fixed profile over the vault's salt. */
export function vaultKdfParams(kdfSalt: string): VaultKdfParams {
  return { ...VAULT_ARGON2_PARAMS, salt: kdfSalt };
}

/**
 * Build a brand-new vault header: fresh salt, fresh `K_c`, one passphrase key
 * slot, and a seal over the whole thing.
 */
export async function buildVaultHeader(input: BuildVaultHeaderInput): Promise<BuiltVaultHeader> {
  const passphrase = requireVaultPassphrase(input.passphrase);
  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const kdfSalt = bytesToBase64(generateVaultSalt(randomBytes));
  const kdf = vaultKdfParams(kdfSalt);
  const contentKey = generateVaultKey(randomBytes);

  let kek: Uint8Array | undefined;
  try {
    kek = await deriveVaultKek(passphrase, kdf, input.deps);
    const slot = await wrapContentKey({
      contentKey,
      kek,
      slotId: uuidFrom(randomBytes),
      slotIndex: 0,
      vaultId: input.vaultId,
      randomBytes,
    });
    const unsealed: VaultHeaderDoc = vaultHeaderDocSchema.parse({
      formatVersion: VAULT2_HEADER_FORMAT_VERSION,
      vaultId: input.vaultId,
      name: input.name,
      kdfSalt,
      kdf,
      keySlots: [slot],
      portfolios: input.portfolios ?? [],
      backends: input.backends,
      headerVersion: 1,
      deviceId: input.deviceId,
      writeId: input.writeId,
      writtenAt: input.writtenAt,
      seal: null,
    });
    return { header: await sealVaultHeader(unsealed, contentKey), contentKey };
  } catch (cause) {
    zeroBytes(contentKey);
    throw asVaultCryptoError('kdf-failed', 'Could not build the vault header.', cause);
  } finally {
    if (kek != null) zeroBytes(kek);
  }
}

/**
 * Recompute and attach the header seal. Every header write goes through here,
 * so a writer that holds `K_c` cannot accidentally publish an unsealed header.
 */
export async function sealVaultHeader(
  header: VaultHeaderDoc,
  contentKey: Uint8Array,
): Promise<VaultHeaderDoc> {
  const iv = sealIv(header);
  const tag = await aesGcmEncrypt(contentKey, iv, new Uint8Array(0), sealBytes(header));
  return { ...header, seal: bytesToBase64(tag) };
}

export type VaultHeaderSealState = 'sealed' | 'unsealed';

export interface OpenedVaultHeader {
  header: VaultHeaderDoc;
  contentKey: Uint8Array;
  slotId: string;
  /**
   * `unsealed` means the header carried no seal — readable, but its portfolio
   * index and backend echo are unauthenticated. Written only by clients older
   * than this one; this client always seals.
   */
  seal: VaultHeaderSealState;
}

/**
 * Open a vault header with its 12 words: derive the KEK, unwrap `K_c` from the
 * first slot that authenticates, then verify the seal.
 *
 * A wrong passphrase, a tampered wrapped key and a tampered header all surface
 * as `authentication-failed` — the caller cannot distinguish "wrong words" from
 * "modified blob", which is deliberate.
 */
export async function openVaultHeader(
  header: VaultHeaderDoc,
  passphrase: string,
  deps?: VaultCryptoDeps,
): Promise<OpenedVaultHeader> {
  const parsed = vaultHeaderDocSchema.parse(header);
  const normalized = requireVaultPassphrase(passphrase);
  let kek: Uint8Array | undefined;
  try {
    kek = await deriveVaultKek(normalized, parsed.kdf, deps);
    for (const [slotIndex, slot] of parsed.keySlots.entries()) {
      if (slot.kind !== 'passphrase') continue;
      const contentKey = await tryUnwrapContentKey(slot, slotIndex, parsed.vaultId, kek);
      if (contentKey == null) continue;
      try {
        const seal = await verifyVaultHeaderSeal(parsed, contentKey);
        return { header: parsed, contentKey, slotId: slot.slotId, seal };
      } catch (cause) {
        zeroBytes(contentKey);
        throw cause;
      }
    }
    throw new VaultCryptoError(
      'authentication-failed',
      'No vault key slot opened with this passphrase.',
    );
  } finally {
    if (kek != null) zeroBytes(kek);
  }
}

/**
 * Verify the header seal against `K_c`. Absent seal → `unsealed`; present but
 * wrong → hard failure, because a forged index is exactly the attack the seal
 * exists to stop.
 */
export async function verifyVaultHeaderSeal(
  header: VaultHeaderDoc,
  contentKey: Uint8Array,
): Promise<VaultHeaderSealState> {
  if (header.seal == null) return 'unsealed';
  const tag = base64ToBytes(header.seal, 'envelope-invalid');
  if (tag.length !== SEAL_TAG_BYTES) {
    throw new VaultCryptoError('envelope-invalid', 'Vault header seal has an invalid length.');
  }
  const iv = sealIv(header);
  const opened = await aesGcmDecrypt(contentKey, iv, tag, sealBytes(header));
  if (opened.length !== 0) {
    throw new VaultCryptoError('authentication-failed', 'Vault header seal is malformed.');
  }
  return 'sealed';
}

/**
 * Replace the vault passphrase: derive a KEK from the new words over a FRESH
 * salt and re-wrap the same `K_c` into a new slot. Portfolio blobs are
 * untouched, so this is O(1) in the amount of stored money data.
 */
export async function changeVaultPassphrase(
  header: VaultHeaderDoc,
  contentKey: Uint8Array,
  nextPassphrase: string,
  write: { deviceId: string; writeId: string; writtenAt: string },
  randomBytes: RandomBytes = secureRandomBytes,
  deps?: VaultCryptoDeps,
): Promise<VaultHeaderDoc> {
  const passphrase = requireVaultPassphrase(nextPassphrase);
  const kdfSalt = bytesToBase64(generateVaultSalt(randomBytes));
  const kdf = vaultKdfParams(kdfSalt);
  let kek: Uint8Array | undefined;
  try {
    kek = await deriveVaultKek(passphrase, kdf, deps);
    const slot = await wrapContentKey({
      contentKey,
      kek,
      slotId: uuidFrom(randomBytes),
      slotIndex: 0,
      vaultId: header.vaultId,
      randomBytes,
    });
    const next = vaultHeaderDocSchema.parse({
      ...header,
      kdfSalt,
      kdf,
      keySlots: [slot],
      headerVersion: header.headerVersion + 1,
      deviceId: write.deviceId,
      writeId: write.writeId,
      writtenAt: write.writtenAt,
      seal: null,
    });
    return await sealVaultHeader(next, contentKey);
  } finally {
    if (kek != null) zeroBytes(kek);
  }
}

/** Produce the next header revision (index/name/backend edits) and re-seal it. */
export async function reviseVaultHeader(
  header: VaultHeaderDoc,
  contentKey: Uint8Array,
  patch: Partial<Pick<VaultHeaderDoc, 'name' | 'backends' | 'portfolios'>>,
  write: { deviceId: string; writeId: string; writtenAt: string },
): Promise<VaultHeaderDoc> {
  const next = vaultHeaderDocSchema.parse({
    ...header,
    ...patch,
    headerVersion: header.headerVersion + 1,
    deviceId: write.deviceId,
    writeId: write.writeId,
    writtenAt: write.writtenAt,
    seal: null,
  });
  return sealVaultHeader(next, contentKey);
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * Additional authenticated data for one key slot (r2 §9): the header format
 * version, the vault id and the slot's INDEX.
 *
 * Binding the index — not only the slot id — is what stops a blob store from
 * reordering `keySlots[]`. Once shared vaults add member slots, reordering
 * would otherwise silently change which member a wrapped key is attributed to.
 */
export function keySlotAad(vaultId: string, slotIndex: number): Uint8Array {
  return utf8(
    JSON.stringify([
      'bettertrack.vault2-key-slot.v1',
      VAULT2_HEADER_FORMAT_VERSION,
      vaultId,
      slotIndex,
    ]),
  );
}

async function wrapContentKey(input: {
  contentKey: Uint8Array;
  kek: Uint8Array;
  slotId: string;
  slotIndex: number;
  vaultId: string;
  randomBytes: RandomBytes;
}): Promise<VaultKeySlot> {
  if (input.contentKey.length !== VAULT_KEY_BYTES) {
    throw new VaultCryptoError('authentication-failed', 'Vault content key must be 256 bits.');
  }
  const iv = input.randomBytes(VAULT_IV_BYTES);
  if (iv.length !== VAULT_IV_BYTES) {
    throw new VaultCryptoError('envelope-invalid', 'Key-slot IV must be 96 bits.');
  }
  try {
    const wrapped = await aesGcmEncrypt(
      input.kek,
      iv,
      input.contentKey,
      keySlotAad(input.vaultId, input.slotIndex),
    );
    const payload = new Uint8Array(iv.length + wrapped.length);
    payload.set(iv);
    payload.set(wrapped, iv.length);
    return { slotId: input.slotId, kind: 'passphrase', wrappedKey: bytesToBase64(payload) };
  } finally {
    zeroBytes(iv);
  }
}

/** Returns `null` on an authentication failure so the next slot can be tried. */
async function tryUnwrapContentKey(
  slot: VaultKeySlot,
  slotIndex: number,
  vaultId: string,
  kek: Uint8Array,
): Promise<Uint8Array | null> {
  let payload: Uint8Array | undefined;
  try {
    payload = base64ToBytes(slot.wrappedKey, 'envelope-invalid');
    if (payload.length !== VAULT_IV_BYTES + VAULT_KEY_BYTES + SEAL_TAG_BYTES) {
      return null;
    }
    const contentKey = await aesGcmDecrypt(
      kek,
      payload.subarray(0, VAULT_IV_BYTES),
      payload.subarray(VAULT_IV_BYTES),
      keySlotAad(vaultId, slotIndex),
    );
    return contentKey.length === VAULT_KEY_BYTES ? contentKey : null;
  } catch {
    return null;
  } finally {
    if (payload != null) zeroBytes(payload);
  }
}

/**
 * The seal's IV is a constant, which is normally forbidden for GCM — but this
 * call encrypts an EMPTY plaintext, so it produces no keystream-encrypted bytes
 * and degenerates to GMAC over the header. Nonce reuse across headers therefore
 * leaks nothing: each header seals different AAD under a different `K_c`.
 */
function sealIv(_header: VaultHeaderDoc): Uint8Array {
  return new Uint8Array(VAULT_IV_BYTES);
}

function sealBytes(header: VaultHeaderDoc): Uint8Array {
  return canonicalSealedHeaderBytes(header);
}

/** RFC 4122 v4 id from the injected CSPRNG so vector tests stay deterministic. */
function uuidFrom(randomBytes: RandomBytes): string {
  const bytes = randomBytes(16);
  if (bytes.length !== 16) {
    throw new VaultCryptoError('envelope-invalid', 'Vault id material must be 128 bits.');
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
