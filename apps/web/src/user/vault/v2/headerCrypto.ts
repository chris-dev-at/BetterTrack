import {
  VAULT2_HEADER_FORMAT_VERSION,
  vaultHeaderDocSchema,
  type VaultBackends,
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

import { attachHeaderMac, verifyHeaderMac, type VaultHeaderSealState } from './headerMac';
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

/** AES-GCM authentication tag length, used to size-check a wrapped key slot. */
const GCM_TAG_BYTES = 16;

export interface BuildVaultHeaderInput {
  vaultId: string;
  name: string;
  backends: VaultBackends;
  passphrase: string;
  portfolios?: VaultPortfolioIndexEntry[];
  deviceId: string;
  writeId: string;
  writtenAt: string;
  /**
   * r3 §18 migration path: the DERIVED content key
   * (`HKDF(VK, "btv2-migration-v1")`) instead of a fresh random one, so every
   * claim holder builds a header that unwraps to the same `K_c`. Normal vault
   * creation never passes this.
   */
  contentKey?: Uint8Array;
  /**
   * r3 §18 migration path: reuse the LEGACY vault's KDF salt (base64) instead
   * of drawing a fresh one, keeping the successor header deterministic.
   */
  kdfSalt?: string;
  /**
   * r2 §9: free-text passphrases remain valid input for v1-MIGRATED vaults
   * only. When set, the passphrase is used verbatim (the v1 KDF never
   * normalized), instead of being required to be 12 checksummed words.
   */
  legacyPassphrase?: boolean;
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

/** Build a brand-new vault header: fresh salt, fresh `K_c`, one passphrase slot. */
export async function buildVaultHeader(input: BuildVaultHeaderInput): Promise<BuiltVaultHeader> {
  const passphrase = input.legacyPassphrase
    ? requireLegacyPassphrase(input.passphrase)
    : requireVaultPassphrase(input.passphrase);
  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const kdfSalt = input.kdfSalt ?? bytesToBase64(generateVaultSalt(randomBytes));
  const kdf = vaultKdfParams(kdfSalt);
  const contentKey = input.contentKey?.slice() ?? generateVaultKey(randomBytes);

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
    const header: VaultHeaderDoc = vaultHeaderDocSchema.parse({
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
    });
    // r3 §21: every header this client writes carries the integrity tag.
    return { header: await attachHeaderMac(header, contentKey), contentKey };
  } catch (cause) {
    zeroBytes(contentKey);
    throw asVaultCryptoError('kdf-failed', 'Could not build the vault header.', cause);
  } finally {
    if (kek != null) zeroBytes(kek);
  }
}

/**
 * r2 §9's carve-out: a v1-MIGRATED vault keeps the free-text passphrase the
 * user already knows, verbatim — the v1 KDF never normalized, so neither may
 * this path. Everything else about the header (slot wrap, AAD, mac) is
 * identical to the 12-word path.
 */
function requireLegacyPassphrase(passphrase: string): string {
  if (passphrase.length === 0) {
    throw new VaultCryptoError('kdf-failed', 'The legacy vault passphrase must be non-empty.');
  }
  return passphrase;
}

export interface OpenedVaultHeader {
  header: VaultHeaderDoc;
  contentKey: Uint8Array;
  slotId: string;
  /**
   * r3 §21: `verified` when the header carried a valid integrity tag,
   * `unsealed` when it carried none (a pre-r3 header — tolerated this arc,
   * upgraded on the next header write). An INVALID tag never reaches the
   * caller: it throws `authentication-failed` instead.
   */
  sealState: VaultHeaderSealState;
}

/**
 * Open a vault header with its 12 words: derive the KEK, unwrap `K_c` from the
 * first slot that authenticates, then verify the r3 §21 integrity tag under
 * the unwrapped key.
 *
 * A wrong passphrase and a tampered wrapped key both surface as
 * `authentication-failed` — the caller cannot distinguish "wrong words" from
 * "modified blob", which is deliberate. A present-but-wrong `mac` also fails
 * closed: a blob store that relabels, adds or drops a portfolio index entry is
 * now DETECTED, not survived silently (the gap r2 §9 recorded is closed).
 *
 * `legacyPassphrase` mirrors {@link buildVaultHeader}: v1-migrated vaults keep
 * their free-text words, verbatim.
 */
export async function openVaultHeader(
  header: VaultHeaderDoc,
  passphrase: string,
  deps?: VaultCryptoDeps,
  options?: { legacyPassphrase?: boolean },
): Promise<OpenedVaultHeader> {
  const parsed = vaultHeaderDocSchema.parse(header);
  const normalized = options?.legacyPassphrase
    ? requireLegacyPassphrase(passphrase)
    : requireVaultPassphrase(passphrase);
  let kek: Uint8Array | undefined;
  try {
    kek = await deriveVaultKek(normalized, parsed.kdf, deps);
    for (const [slotIndex, slot] of parsed.keySlots.entries()) {
      if (slot.kind !== 'passphrase') continue;
      const contentKey = await tryUnwrapContentKey(slot, slotIndex, parsed.vaultId, kek);
      if (contentKey == null) continue;
      let sealState: VaultHeaderSealState;
      try {
        sealState = await verifyHeaderMac(parsed, contentKey);
      } catch (cause) {
        zeroBytes(contentKey);
        throw cause;
      }
      return { header: parsed, contentKey, slotId: slot.slotId, sealState };
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
    });
    // r3 §21: the rewritten header is re-sealed under the same content key.
    return await attachHeaderMac(next, contentKey);
  } finally {
    if (kek != null) zeroBytes(kek);
  }
}

/**
 * Add another passphrase slot wrapping the SAME `K_c` (the §2 multi-slot hook,
 * pinned by vector family 2). The new slot's KEK is derived from `passphrase`
 * over the header's existing `kdf`, and its AAD binds its INDEX — so a blob
 * store cannot reorder the slots and re-attribute a wrapped key once shared
 * vaults add members. Any slot still opens the vault.
 */
export async function addPassphraseSlot(
  header: VaultHeaderDoc,
  contentKey: Uint8Array,
  passphrase: string,
  write: { deviceId: string; writeId: string; writtenAt: string },
  randomBytes: RandomBytes = secureRandomBytes,
  deps?: VaultCryptoDeps,
): Promise<VaultHeaderDoc> {
  const normalized = requireVaultPassphrase(passphrase);
  const slotIndex = header.keySlots.length;
  let kek: Uint8Array | undefined;
  try {
    kek = await deriveVaultKek(normalized, header.kdf, deps);
    const slot = await wrapContentKey({
      contentKey,
      kek,
      slotId: uuidFrom(randomBytes),
      slotIndex,
      vaultId: header.vaultId,
      randomBytes,
    });
    const next = vaultHeaderDocSchema.parse({
      ...header,
      keySlots: [...header.keySlots, slot],
      headerVersion: header.headerVersion + 1,
      deviceId: write.deviceId,
      writeId: write.writeId,
      writtenAt: write.writtenAt,
    });
    return await attachHeaderMac(next, contentKey);
  } finally {
    if (kek != null) zeroBytes(kek);
  }
}

/**
 * Produce the next header revision (index/name/backend edits), re-sealed under
 * the vault content key (r3 §21) — which is also the upgrade-on-write path for
 * a pre-r3 `unsealed` header: its first revision attaches the tag.
 */
export async function reviseVaultHeader(
  header: VaultHeaderDoc,
  patch: Partial<Pick<VaultHeaderDoc, 'name' | 'backends' | 'portfolios'>>,
  write: { deviceId: string; writeId: string; writtenAt: string },
  contentKey: Uint8Array,
): Promise<VaultHeaderDoc> {
  const next = vaultHeaderDocSchema.parse({
    ...header,
    ...patch,
    headerVersion: header.headerVersion + 1,
    deviceId: write.deviceId,
    writeId: write.writeId,
    writtenAt: write.writtenAt,
  });
  return attachHeaderMac(next, contentKey);
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
    if (payload.length !== VAULT_IV_BYTES + VAULT_KEY_BYTES + GCM_TAG_BYTES) {
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
