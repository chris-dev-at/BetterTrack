import {
  VAULT_ACCOUNT_BINDING_INFO_PREFIX,
  VAULT_KEY_FINGERPRINT_CHARS,
  VAULT_KEY_FINGERPRINT_HKDF_INFO,
  VAULT_KEY_SLOT_SEED_V1,
  VAULT_WRAP_HKDF_INFO_PREFIX,
  vaultAccountBindingSchema,
  vaultIdParamSchema,
  type VaultKeyFingerprint,
  type VaultKeySlot,
} from '@bettertrack/contracts';

import { equalBytes, utf8, zeroBytes } from '../bytes';
import {
  VAULT_IV_BYTES,
  VAULT_KEY_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  secureRandomBytes,
  type RandomBytes,
} from '../crypto';
import { deriveMnemonicSeed } from '../bip39/mnemonic';
import { hkdfSha256 } from '../hkdf';
import { decodeBase64Url, encodeBase64Url } from './base64url';
import { VaultKeyCoreError, asVaultKeyCoreError } from './errors';
import { requireContentKey, requireKey } from './keyValidation';

export const VAULT_CONTENT_KEY_BYTES = VAULT_KEY_BYTES;
export const VAULT_WRAP_KEY_BYTES = VAULT_KEY_BYTES;
export const VAULT_KEY_SLOT_WRAP_AAD_PREFIX = 'bettertrack-vault-key-slot-v1:';

const GCM_TAG_BYTES = 16;
const WRAPPED_CONTENT_KEY_BYTES = VAULT_IV_BYTES + VAULT_CONTENT_KEY_BYTES + GCM_TAG_BYTES;
const HKDF_HASH_BYTES = 32;
const EMPTY_HKDF_SALT = new Uint8Array(0);

export interface VaultContentKeyMaterial {
  vaultId: string;
  keyId: string;
  contentKey: Uint8Array;
  keySlot: VaultKeySlot;
  keyFingerprint: VaultKeyFingerprint;
}

export interface CreateVaultKeyMaterialInput {
  mnemonic: string;
  vaultId: string;
  keyId: string;
  randomBytes?: RandomBytes;
}

export async function deriveVaultWrapKey(mnemonic: string, vaultId: string): Promise<Uint8Array> {
  requireVaultId(vaultId);
  const seed = await deriveMnemonicSeed(mnemonic);
  try {
    return await hkdfSha256(
      seed,
      utf8(VAULT_WRAP_HKDF_INFO_PREFIX + vaultId),
      VAULT_WRAP_KEY_BYTES,
      EMPTY_HKDF_SALT,
    );
  } catch (cause) {
    throw asVaultKeyCoreError(
      'invalid-key-material',
      'Could not derive the vault wrap key.',
      cause,
    );
  } finally {
    zeroBytes(seed);
  }
}

export function generateContentKey(randomBytes: RandomBytes = secureRandomBytes): Uint8Array {
  const contentKey = randomBytes(VAULT_CONTENT_KEY_BYTES);
  try {
    requireContentKey(contentKey);
    return contentKey;
  } catch (cause) {
    if (contentKey instanceof Uint8Array) zeroBytes(contentKey);
    throw cause;
  }
}

export async function wrapContentKey(input: {
  contentKey: Uint8Array;
  wrapKey: Uint8Array;
  vaultId: string;
  keyId: string;
  randomBytes?: RandomBytes;
}): Promise<VaultKeySlot> {
  requireContentKey(input.contentKey);
  requireKey(input.wrapKey, 'Wrap key');
  requireSlotIdentity(input.vaultId, input.keyId);
  const iv = (input.randomBytes ?? secureRandomBytes)(VAULT_IV_BYTES);
  let ciphertext: Uint8Array | undefined;
  try {
    if (!(iv instanceof Uint8Array) || iv.length !== VAULT_IV_BYTES) {
      throw new VaultKeyCoreError('invalid-key-material', 'Key-slot IV must be 96 bits.');
    }
    ciphertext = await aesGcmEncrypt(
      input.wrapKey,
      iv,
      input.contentKey,
      keySlotAad(input.vaultId, input.keyId),
    );
    const payload = new Uint8Array(iv.length + ciphertext.length);
    payload.set(iv);
    payload.set(ciphertext, iv.length);
    try {
      return {
        keyId: input.keyId,
        slot: VAULT_KEY_SLOT_SEED_V1,
        wrappedKc: encodeBase64Url(payload),
      };
    } finally {
      zeroBytes(payload);
    }
  } catch (cause) {
    throw asVaultKeyCoreError('authentication-failed', 'Could not wrap the content key.', cause);
  } finally {
    if (iv instanceof Uint8Array) zeroBytes(iv);
    if (ciphertext != null) zeroBytes(ciphertext);
  }
}

export async function unwrapContentKey(input: {
  keySlot: VaultKeySlot;
  wrapKey: Uint8Array;
  vaultId: string;
  keyId: string;
}): Promise<Uint8Array> {
  requireKey(input.wrapKey, 'Wrap key');
  requireSlotIdentity(input.vaultId, input.keyId);
  if (input.keySlot.slot !== VAULT_KEY_SLOT_SEED_V1 || input.keySlot.keyId !== input.keyId) {
    throw new VaultKeyCoreError('slot-invalid', 'Active key slot does not match the key id.');
  }
  const payload = decodeBase64Url(input.keySlot.wrappedKc);
  try {
    if (payload.length !== WRAPPED_CONTENT_KEY_BYTES) {
      throw new VaultKeyCoreError('slot-invalid', 'Wrapped content key has an invalid length.');
    }
    const contentKey = await aesGcmDecrypt(
      input.wrapKey,
      payload.subarray(0, VAULT_IV_BYTES),
      payload.subarray(VAULT_IV_BYTES),
      keySlotAad(input.vaultId, input.keyId),
    );
    try {
      requireContentKey(contentKey);
      return contentKey;
    } catch (cause) {
      zeroBytes(contentKey);
      throw cause;
    }
  } catch (cause) {
    throw asVaultKeyCoreError(
      'authentication-failed',
      'Could not authenticate the wrapped content key.',
      cause,
    );
  } finally {
    zeroBytes(payload);
  }
}

export function selectActiveSeedKeySlot(
  keySlots: readonly VaultKeySlot[],
  keyId: string,
): VaultKeySlot {
  const active = keySlots.filter(
    (keySlot) => keySlot.slot === VAULT_KEY_SLOT_SEED_V1 && keySlot.keyId === keyId,
  );
  if (active.length !== 1) {
    throw new VaultKeyCoreError(
      'slot-invalid',
      'Envelope must contain exactly one active seed-v1 key slot.',
    );
  }
  return active[0]!;
}

export async function deriveKeyFingerprint(contentKey: Uint8Array): Promise<VaultKeyFingerprint> {
  requireContentKey(contentKey);
  const fingerprintBytes = await hkdfSha256(
    contentKey,
    utf8(VAULT_KEY_FINGERPRINT_HKDF_INFO),
    HKDF_HASH_BYTES,
    EMPTY_HKDF_SALT,
  );
  try {
    return encodeBase64Url(fingerprintBytes).slice(
      0,
      VAULT_KEY_FINGERPRINT_CHARS,
    ) as VaultKeyFingerprint;
  } finally {
    zeroBytes(fingerprintBytes);
  }
}

export async function createVaultKeyMaterial(
  input: CreateVaultKeyMaterialInput,
): Promise<VaultContentKeyMaterial> {
  const wrapKey = await deriveVaultWrapKey(input.mnemonic, input.vaultId);
  const contentKey = generateContentKey(input.randomBytes);
  try {
    const keySlot = await wrapContentKey({
      contentKey,
      wrapKey,
      vaultId: input.vaultId,
      keyId: input.keyId,
      randomBytes: input.randomBytes,
    });
    const keyFingerprint = await deriveKeyFingerprint(contentKey);
    return {
      vaultId: input.vaultId,
      keyId: input.keyId,
      contentKey,
      keySlot,
      keyFingerprint,
    };
  } catch (cause) {
    zeroBytes(contentKey);
    throw cause;
  } finally {
    zeroBytes(wrapKey);
  }
}

export async function openVaultKey(input: {
  mnemonic: string;
  vaultId: string;
  keyId: string;
  keySlots: readonly VaultKeySlot[];
  expectedFingerprint?: VaultKeyFingerprint;
}): Promise<VaultContentKeyMaterial> {
  const keySlot = selectActiveSeedKeySlot(input.keySlots, input.keyId);
  const wrapKey = await deriveVaultWrapKey(input.mnemonic, input.vaultId);
  let contentKey: Uint8Array | undefined;
  try {
    contentKey = await unwrapContentKey({
      keySlot,
      wrapKey,
      vaultId: input.vaultId,
      keyId: input.keyId,
    });
    const keyFingerprint = await deriveKeyFingerprint(contentKey);
    if (
      input.expectedFingerprint != null &&
      !equalFingerprint(keyFingerprint, input.expectedFingerprint)
    ) {
      throw new VaultKeyCoreError(
        'fingerprint-mismatch',
        'The phrase does not match the expected vault fingerprint.',
      );
    }
    return {
      vaultId: input.vaultId,
      keyId: input.keyId,
      contentKey,
      keySlot,
      keyFingerprint,
    };
  } catch (cause) {
    if (contentKey != null) zeroBytes(contentKey);
    throw cause;
  } finally {
    zeroBytes(wrapKey);
  }
}

export async function deriveAccountBinding(accountId: string): Promise<string> {
  if (accountId.length === 0) {
    throw new VaultKeyCoreError('invalid-key-material', 'Account id must not be empty.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle == null) {
    throw new VaultKeyCoreError('unsupported-crypto', 'WebCrypto SHA-256 is unavailable.');
  }
  const digest = new Uint8Array(
    await subtle.digest('SHA-256', utf8(VAULT_ACCOUNT_BINDING_INFO_PREFIX + accountId)),
  );
  try {
    const binding = encodeBase64Url(digest);
    if (!vaultAccountBindingSchema.safeParse(binding).success) {
      throw new VaultKeyCoreError('invalid-key-material', 'Account binding is invalid.');
    }
    return binding;
  } finally {
    zeroBytes(digest);
  }
}

function requireVaultId(vaultId: string): void {
  if (!vaultIdParamSchema.safeParse({ vaultId }).success) {
    throw new VaultKeyCoreError('invalid-key-material', 'Vault id is invalid.');
  }
}

function requireSlotIdentity(vaultId: string, keyId: string): void {
  requireVaultId(vaultId);
  if (!vaultIdParamSchema.safeParse({ vaultId: keyId }).success) {
    throw new VaultKeyCoreError('invalid-key-material', 'Key id is invalid.');
  }
}

function keySlotAad(vaultId: string, keyId: string): Uint8Array {
  return utf8(`${VAULT_KEY_SLOT_WRAP_AAD_PREFIX}${vaultId}:${keyId}`);
}

function equalFingerprint(left: string, right: string): boolean {
  return equalBytes(utf8(left), utf8(right));
}
