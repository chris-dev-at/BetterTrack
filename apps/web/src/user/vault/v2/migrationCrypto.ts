import { sha256 } from 'hash-wasm';

import { utf8 } from '../bytes';
import { VAULT_IV_BYTES } from '../crypto';
import { VaultCryptoError } from '../errors';
import { hkdfSha256, uuidFromBytes } from '../hkdf';

/**
 * Deterministic migration crypto (`docs/VAULTS_V2_DESIGN.md` r3 §18).
 *
 * The r2 §11 claim protocol made migration idempotent in ADDRESSING (doc
 * identities are deterministic). r3 makes it idempotent in BYTES: two claim
 * holders — first, resumed, or racing — write byte-identical ciphertext from
 * identical legacy content. That is what closes mobile finding A2.1, where two
 * clients minting random content keys wrote mutually undecryptable blobs under
 * one identity.
 *
 * Everything the migration writer needs is a pure function of the legacy vault
 * key `VK` (which every claim holder already holds once the legacy vault is
 * unlocked) and the deterministic doc identity:
 *
 *  - `K_c  = HKDF-SHA256(VK, "btv2-migration-v1", 32)`
 *  - `IV(docId) = HKDF-SHA256(K_c, "btv2-migration-iv" ‖ docId, 12)`
 *  - writer identity, header salt/IV, and the vault id — all derived below.
 *
 * **IV safety.** GCM breaks only when one `(key, IV)` pair encrypts two
 * DIFFERENT plaintexts. Here the plaintext for a `docId` is a pure function of
 * the legacy document (the split is deterministic and vector-pinned), `K_c` is
 * a pure function of `VK`, and `IV` is a pure function of `(K_c, docId)` — so
 * every `(key, IV, plaintext)` triple is fixed and unique per `docId`. Normal
 * operation keeps random IVs; this determinism is scoped to migration writes.
 */

export const MIGRATION_CONTENT_KEY_INFO = 'btv2-migration-v1';
export const MIGRATION_IV_INFO = 'btv2-migration-iv';
export const MIGRATION_DEVICE_INFO = 'btv2-migration-device';
export const MIGRATION_WRITE_INFO = 'btv2-migration-write';
export const MIGRATION_HEADER_INFO = 'btv2-migration-header';
export const MIGRATION_VAULT_ID_CONTEXT = 'btv2-migration-vault-id:';

/** The migration doc id used in IV/writeId derivation: `common` or `p.{portfolioId}`. */
export function migrationDocId(doc: {
  kind: 'header' | 'common' | 'portfolio';
  portfolioId?: string;
}): string {
  if (doc.kind === 'header') return 'header';
  if (doc.kind === 'common') return 'common';
  if (!doc.portfolioId) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'A migration portfolio doc needs a portfolioId.',
    );
  }
  return `p.${doc.portfolioId}`;
}

/** `K_c = HKDF-SHA256(VK, "btv2-migration-v1", 32)` (r3 §18). */
export async function deriveMigrationContentKey(legacyVaultKey: Uint8Array): Promise<Uint8Array> {
  if (legacyVaultKey.length !== 32) {
    throw new VaultCryptoError('kdf-failed', 'The legacy vault key must be 256 bits.');
  }
  return hkdfSha256(legacyVaultKey, utf8(MIGRATION_CONTENT_KEY_INFO), 32);
}

/** `IV(docId) = HKDF-SHA256(K_c, "btv2-migration-iv" ‖ docId, 12)`. */
export function deriveMigrationIv(contentKey: Uint8Array, docId: string): Promise<Uint8Array> {
  return hkdfSha256(contentKey, concat(utf8(MIGRATION_IV_INFO), utf8(docId)), VAULT_IV_BYTES);
}

/** Deterministic writer device id: `uuid(HKDF(K_c, "btv2-migration-device", 16))`. */
export async function deriveMigrationDeviceId(contentKey: Uint8Array): Promise<string> {
  return uuidFromBytes(await hkdfSha256(contentKey, utf8(MIGRATION_DEVICE_INFO), 16));
}

/** Deterministic per-doc write id: `uuid(HKDF(K_c, "btv2-migration-write" ‖ docId, 16))`. */
export async function deriveMigrationWriteId(
  contentKey: Uint8Array,
  docId: string,
): Promise<string> {
  return uuidFromBytes(
    await hkdfSha256(contentKey, concat(utf8(MIGRATION_WRITE_INFO), utf8(docId)), 16),
  );
}

export interface MigrationHeaderMaterial {
  /** 16 bytes for the header key-slot id. */
  slotIdBytes: Uint8Array;
  /** 12 bytes for the header key-slot wrap IV. */
  slotIvBytes: Uint8Array;
}

/**
 * Header slot id + wrap IV, drawn from one 28-byte expansion so the migration
 * header is byte-identical across claim holders. The header's `kdfSalt` is the
 * legacy vault's own salt (supplied by the caller), and its `writtenAt` is the
 * legacy envelope's `writtenAt` — neither is derived here.
 */
export async function deriveMigrationHeaderMaterial(
  contentKey: Uint8Array,
): Promise<MigrationHeaderMaterial> {
  const bytes = await hkdfSha256(contentKey, utf8(MIGRATION_HEADER_INFO), 28);
  return { slotIdBytes: bytes.slice(0, 16), slotIvBytes: bytes.slice(16, 28) };
}

/**
 * The successor vault id (r3 §18):
 * `uuid(SHA-256("btv2-migration-vault-id:" ‖ scopeId)[0..16])`.
 *
 * `scopeId` is the account `userId` for server-coordinated migrations and the
 * Drive-local `accountId` for Drive-only vaults. Public and derivable before
 * any unlock, which is what lets the client mint the id the create route wants.
 */
export async function deriveMigrationVaultId(scopeId: string): Promise<string> {
  const digestHex = await sha256(utf8(MIGRATION_VAULT_ID_CONTEXT + scopeId));
  const bytes = Uint8Array.from(digestHex.match(/../gu)!.map((pair) => parseInt(pair, 16)));
  return uuidFromBytes(bytes.slice(0, 16));
}

/**
 * A RandomBytes source that serves the migration header's derived slot id and
 * wrap IV in the order {@link buildVaultHeader} consumes them: a 16-byte draw
 * for the slot id (uuidFrom), then a 12-byte draw for the wrap IV. Any further
 * draw is an error — the migration header must be fully deterministic.
 */
export function migrationHeaderRandom(
  material: MigrationHeaderMaterial,
): (length: number) => Uint8Array {
  const queue: Uint8Array[] = [material.slotIdBytes, material.slotIvBytes];
  return (length: number) => {
    const next = queue.shift();
    if (next == null || next.length !== length) {
      throw new VaultCryptoError(
        'envelope-invalid',
        'Migration header derivation drew an unexpected amount of randomness.',
      );
    }
    return next;
  };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
