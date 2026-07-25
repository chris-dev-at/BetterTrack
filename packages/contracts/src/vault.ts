import { z } from 'zod';

/**
 * Paranoid mode — the client-encrypted vault (PROJECTPLAN.md §13.5 V5-P13 arc b;
 * `docs/paranoid-design.md` §1, §2, §4). This module is the **single source of
 * truth** for the on-disk/on-wire vault format across every storage medium
 * (BetterTrack server, the user's Google Drive, or both). It is deliberately
 * import-free and isomorphic (browser + Node) so the web/PWA client and the API
 * derive the exact same shapes.
 *
 * The server is a **blind blob store with compare-and-swap**: it never decrypts,
 * parses past the header it needs for CAS, logs, or indexes the payload. The two
 * fields it reads live in {@link vaultServerHeaderSchema}; everything else in the
 * envelope is opaque to it. The key never leaves the user's devices.
 *
 * Scope note (PD2): this file pins the envelope header, the structural vault
 * document v1, the media set, the privacy-mode values and the vault endpoint
 * DTOs. The concrete per-entity payload shapes inside {@link vaultDocumentV1Schema}
 * are refined by the client crypto/valuation work (PD4/PD7); v1 fixes the
 * envelope + entity-metadata contract they build on.
 */

// ── Format constants ─────────────────────────────────────────────────────────

/** ASCII magic prefixing every envelope (`docs/paranoid-design.md` §2). */
export const VAULT_MAGIC = 'BTVAULT1';
/** Big-endian byte length of the header-length prefix that follows the magic. */
export const VAULT_HEADER_LENGTH_PREFIX_BYTES = 4;
/** Envelope layout version (`formatVersion` in the header). */
export const VAULT_FORMAT_VERSION = 1;
/** Payload document version (`schemaVersion` in the header + document). */
export const VAULT_DOCUMENT_VERSION = 1;
/** Content cipher — WebCrypto AES-256-GCM (native on every target platform). */
export const VAULT_CONTENT_CIPHER = 'A256GCM';
/** KEK derivation — Argon2id (the server's own argon2id cost family). */
export const VAULT_KDF_ALG = 'argon2id';
/** Default server-enforced ciphertext size cap: 16 MiB (`§2`, env-tunable). */
export const VAULT_MAX_BYTES_DEFAULT = 16 * 1024 * 1024;
/** Default and hard per-request bounds for blind server-history enumeration. */
export const VAULT_HISTORY_PAGE_DEFAULT = 10;
export const VAULT_HISTORY_PAGE_MAX = 10;

// ── Privacy mode + media set ─────────────────────────────────────────────────

/**
 * Account privacy mode (`users.privacy_mode`, `docs/paranoid-design.md` §1). It
 * is account metadata (present even in Drive-only mode) — knowing THAT a user is
 * paranoid is not portfolio data; it is required to enforce the §8 kill list.
 */
export const PRIVACY_MODES = ['normal', 'paranoid'] as const;
export const privacyModeSchema = z.enum(PRIVACY_MODES);
export type PrivacyMode = z.infer<typeof privacyModeSchema>;

/**
 * A storage medium a blob syncs to (`§4`). `server` = the BetterTrack blind
 * store; `drive` = the user's Google Drive appdata folder. Both are blind
 * compare-and-swap blob stores; the client picks a non-empty subset.
 */
export const VAULT_MEDIA = ['server', 'drive'] as const;
export const vaultMediumSchema = z.enum(VAULT_MEDIA);
export type VaultMedium = z.infer<typeof vaultMediumSchema>;

/**
 * The user's chosen media (`§4` mediaSet): a NON-EMPTY subset with no repeats.
 * `{server}` = server, `{drive}` = Drive-only (zero portfolio bytes server-
 * side), `{server, drive}` = both. The last medium can never be removed.
 */
export const vaultMediaSetSchema = z
  .array(vaultMediumSchema)
  .min(1, 'a media set must contain at least one medium')
  .refine((media) => new Set(media).size === media.length, {
    message: 'a media set must not repeat a medium',
  });
export type VaultMediaSet = z.infer<typeof vaultMediaSetSchema>;

// ── Version + envelope header ────────────────────────────────────────────────

/** The monotonic CAS token (`vaultVersion`). The first stored blob is 1. */
export const vaultVersionSchema = z.number().int().min(1);

/**
 * Public metadata for one retained server-history blob. This is deliberately
 * strict: no cleartext-derived counts, entity names, hashes or payload fields
 * may cross the blind-store boundary.
 */
export const vaultHistoryMetadataSchema = z
  .object({
    version: vaultVersionSchema,
    createdAt: z.string().datetime(),
    sizeBytes: z.number().int().positive(),
    medium: z.literal('server'),
  })
  .strict();
export type VaultHistoryMetadata = z.infer<typeof vaultHistoryMetadataSchema>;

/** Keyset pagination for `GET /vault/history`, newest version first. */
export const vaultHistoryListQuerySchema = z
  .object({
    cursor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type VaultHistoryListQuery = z.infer<typeof vaultHistoryListQuerySchema>;

export const vaultHistoryListResponseSchema = z
  .object({
    items: z.array(vaultHistoryMetadataSchema),
    nextCursor: vaultVersionSchema.nullable(),
  })
  .strict();
export type VaultHistoryListResponse = z.infer<typeof vaultHistoryListResponseSchema>;

/** Route params for the opaque `GET /vault/history/:version` blob read. */
export const vaultHistoryVersionParamSchema = z
  .object({ version: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict();
export type VaultHistoryVersionParam = z.infer<typeof vaultHistoryVersionParamSchema>;

/** Argon2id parameters that wrap the vault key (cleartext, no portfolio data). */
export const vaultKdfParamsSchema = z.object({
  alg: z.literal(VAULT_KDF_ALG),
  m: z.number().int().positive(),
  t: z.number().int().positive(),
  p: z.number().int().positive(),
  salt: z.string().min(1),
});
export type VaultKdfParams = z.infer<typeof vaultKdfParamsSchema>;

/** A passphrase-wrapped copy of the vault key. Multiple allow passphrase change. */
export const vaultWrappedKeySchema = z.object({
  keyId: z.string().uuid(),
  kdf: vaultKdfParamsSchema,
  wrappedVk: z.string().min(1),
});
export type VaultWrappedKey = z.infer<typeof vaultWrappedKeySchema>;

/**
 * The full cleartext envelope header (`§2`). It carries ONLY counters, ids and
 * crypto parameters — never portfolio information. The whole header is bound as
 * GCM additional authenticated data, so any tampering (including edits to
 * `vaultVersion` or the wrapped keys) fails decryption on the client.
 *
 * This is the CLIENT-side contract (client-validated). The server never parses
 * the full header — see {@link vaultServerHeaderSchema} for the two fields it
 * reads.
 */
export const vaultEnvelopeHeaderSchema = z.object({
  formatVersion: z.literal(VAULT_FORMAT_VERSION),
  cipher: z.literal(VAULT_CONTENT_CIPHER),
  iv: z.string().min(1),
  keyId: z.string().uuid(),
  wrappedKeys: z.array(vaultWrappedKeySchema).min(1),
  vaultVersion: vaultVersionSchema,
  schemaVersion: z.number().int().positive(),
  deviceId: z.string().uuid(),
  writeId: z.string().uuid(),
  writtenAt: z.string().datetime(),
});
export type VaultEnvelopeHeader = z.infer<typeof vaultEnvelopeHeaderSchema>;

/**
 * The ONLY view of the header the server is allowed to read — the format version
 * and the monotonic CAS token. Non-strict, so it strips every other header field
 * on parse: the server literally cannot inspect the crypto parameters or wrapped
 * keys, let alone the ciphertext. This is the mechanical guarantee behind "the
 * server never parses past the header it needs for CAS" (`§2`).
 */
export const vaultServerHeaderSchema = z.object({
  formatVersion: z.number().int().positive(),
  vaultVersion: vaultVersionSchema,
});
export type VaultServerHeader = z.infer<typeof vaultServerHeaderSchema>;

// ── Vault document v1 (structural) ───────────────────────────────────────────

/**
 * The entity kinds that live in the encrypted vault document. A superset of the
 * portfolio/money entities the server hard-deletes at enable (the
 * `PARANOID_TABLE_CLASSIFICATION` `vault` set) — derived-only tables (snapshots)
 * are recomputed client-side, not serialized here (`§10`).
 */
export const VAULT_ENTITY_KINDS = [
  'portfolio',
  'transaction',
  'dividend',
  'cashSource',
  'cashMovement',
  'portfolioSetting',
  'taxSetting',
  'customAsset',
  'customAssetValue',
  'standingOrder',
  'expenseCategory',
  'expenseTransaction',
  'expenseRule',
  'expenseBudget',
] as const;
export const vaultEntityKindSchema = z.enum(VAULT_ENTITY_KINDS);
export type VaultEntityKind = z.infer<typeof vaultEntityKindSchema>;

/**
 * Per-entity sync metadata (`§2`/`§4`): a uuidv7 id, a monotonic `rev` bumped on
 * every edit, an `editedAt` instant + the writing `editedBy` deviceId, and a
 * `deletedAt` tombstone (kept ≥ 180 days) so long-offline merges stay correct.
 * The entity-granularity merge rules (`§4`) key off exactly these fields.
 */
export const vaultEntityMetaSchema = z.object({
  id: z.string().uuid(),
  rev: z.number().int().nonnegative(),
  editedAt: z.string().datetime(),
  editedBy: z.string().uuid(),
  deletedAt: z.string().datetime().nullable(),
});
export type VaultEntityMeta = z.infer<typeof vaultEntityMetaSchema>;

/**
 * One vault entity: sync metadata plus its `data` payload. The payload is left
 * open (a JSON record) at v1 — the concrete per-kind shapes are pinned by the
 * client crypto/valuation work (PD4/PD7), which reuses the existing portfolio
 * contracts. Server code never sees this decrypted.
 */
export const vaultEntitySchema = vaultEntityMetaSchema.extend({
  data: z.record(z.string(), z.unknown()),
});
export type VaultEntity = z.infer<typeof vaultEntitySchema>;

/** A merge diagnostic record (`§4`); the payload keeps the last 20. */
export const vaultMergeRecordSchema = z.object({
  mergedAt: z.string().datetime(),
  parents: z.array(vaultVersionSchema).min(1),
  into: vaultVersionSchema,
  deviceId: z.string().uuid(),
});
export type VaultMergeRecord = z.infer<typeof vaultMergeRecordSchema>;

/**
 * The decrypted vault document, version 1 (`§2`). A per-kind map of sync-tracked
 * entities plus a bounded merge log. Clients migrate older documents forward
 * with pure `v(n)→v(n+1)` functions and write back at the current version; a
 * client meeting a newer version than it knows goes read-only, never destructive.
 */
export const vaultDocumentV1Schema = z.object({
  schemaVersion: z.literal(VAULT_DOCUMENT_VERSION),
  entities: z.record(vaultEntityKindSchema, z.array(vaultEntitySchema)),
  mergeLog: z.array(vaultMergeRecordSchema).max(20).default([]),
});
export type VaultDocumentV1 = z.infer<typeof vaultDocumentV1Schema>;

// ── Endpoint DTOs + metadata ─────────────────────────────────────────────────

/**
 * Vault metadata the server MAY expose without ever reading the payload (`§11`
 * `DataHome.info()`, `§12` admin): the CAS version, the format version, the
 * ciphertext size and when it last changed. No portfolio numbers — that IS the
 * feature.
 */
export const vaultMetadataSchema = z.object({
  version: vaultVersionSchema,
  formatVersion: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export type VaultMetadata = z.infer<typeof vaultMetadataSchema>;

/**
 * Typed error codes the vault store raises in the standard `{ error }` envelope
 * (§8):
 *  - `VAULT_NOT_FOUND` (404): no blob exists yet for this account/medium.
 *  - `VAULT_PRECONDITION_REQUIRED` (428): a `PUT` carried neither `If-Match`
 *    (replace) nor `If-None-Match: *` (create) — CAS is mandatory.
 *  - `VAULT_PRECONDITION_FAILED` (412): the supplied precondition lost the CAS
 *    race — a stale/missing version. Newer ciphertext is NEVER overwritten.
 *  - `VAULT_TOO_LARGE` (413): the payload exceeds the configured size cap.
 *  - `VAULT_MALFORMED` (400): the bytes are not a well-formed envelope (bad
 *    magic/length prefix/header, or a non-advancing version).
 */
export const VAULT_ERROR_CODES = {
  notFound: 'VAULT_NOT_FOUND',
  modeRequired: 'VAULT_PARANOID_MODE_REQUIRED',
  preconditionRequired: 'VAULT_PRECONDITION_REQUIRED',
  preconditionFailed: 'VAULT_PRECONDITION_FAILED',
  tooLarge: 'VAULT_TOO_LARGE',
  malformed: 'VAULT_MALFORMED',
} as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[keyof typeof VAULT_ERROR_CODES];

/** The opaque `application/octet-stream` content type the vault blob rides on. */
export const VAULT_CONTENT_TYPE = 'application/octet-stream';
/** Safe metadata headers accompanying one raw historical ciphertext response. */
export const VAULT_HISTORY_CREATED_AT_HEADER = 'X-BetterTrack-Vault-Created-At';
export const VAULT_HISTORY_MEDIUM_HEADER = 'X-BetterTrack-Vault-Medium';
export const VAULT_HISTORY_SIZE_BYTES_HEADER = 'X-BetterTrack-Vault-Size-Bytes';

/** Format a strong ETag over a vault version (`ETag: "<version>"`). */
export function vaultEtag(version: number): string {
  return `"${version}"`;
}

/**
 * Parse a vault version out of an `ETag` / `If-Match` value. Accepts an optional
 * weak marker and quotes; returns the integer version, or `null` when the value
 * is absent or not a bare non-negative integer (so `*` and lists are rejected —
 * the vault CAS is only ever against one concrete version).
 */
export function parseVaultEtag(value: string | undefined | null): number | null {
  if (value == null) return null;
  const bare = value
    .trim()
    .replace(/^W\//i, '')
    .replace(/^"(.*)"$/, '$1');
  if (!/^\d+$/.test(bare)) return null;
  const n = Number(bare);
  return Number.isSafeInteger(n) ? n : null;
}

// ── Envelope codec (isomorphic) ──────────────────────────────────────────────

/** Thrown when raw bytes are not a well-formed vault envelope. */
export class VaultEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultEnvelopeError';
  }
}

const MAGIC_BYTES = new Uint8Array(VAULT_MAGIC.length);
for (let i = 0; i < VAULT_MAGIC.length; i += 1) MAGIC_BYTES[i] = VAULT_MAGIC.charCodeAt(i);
const ENVELOPE_PREFIX_BYTES = VAULT_MAGIC.length + VAULT_HEADER_LENGTH_PREFIX_BYTES;

/**
 * Encode a header + ciphertext into the wire envelope: magic · 4-byte big-endian
 * header length · UTF-8 JSON header · ciphertext (`§2`). Pure and isomorphic.
 */
export function encodeVaultEnvelope(
  header: VaultEnvelopeHeader | Record<string, unknown>,
  ciphertext: Uint8Array,
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(ENVELOPE_PREFIX_BYTES + headerBytes.length + ciphertext.length);
  out.set(MAGIC_BYTES, 0);
  new DataView(out.buffer).setUint32(VAULT_MAGIC.length, headerBytes.length, false);
  out.set(headerBytes, ENVELOPE_PREFIX_BYTES);
  out.set(ciphertext, ENVELOPE_PREFIX_BYTES + headerBytes.length);
  return out;
}

/**
 * Split a wire envelope into its parts WITHOUT decrypting: the parsed JSON header
 * (still `unknown` — callers validate with the schema they are entitled to) and
 * the ciphertext slice. Throws {@link VaultEnvelopeError} on any malformation.
 * This is the only read the server performs on a blob.
 */
export function decodeVaultEnvelope(bytes: Uint8Array): {
  header: unknown;
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (bytes.length < ENVELOPE_PREFIX_BYTES) {
    throw new VaultEnvelopeError('vault envelope shorter than its fixed prefix');
  }
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new VaultEnvelopeError('bad vault envelope magic');
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    VAULT_MAGIC.length,
    false,
  );
  const headerStart = ENVELOPE_PREFIX_BYTES;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > bytes.length) {
    throw new VaultEnvelopeError('vault envelope header length exceeds the blob');
  }
  const headerBytes = bytes.subarray(headerStart, headerEnd);
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch {
    throw new VaultEnvelopeError('vault envelope header is not valid JSON');
  }
  return { header, headerBytes, ciphertext: bytes.subarray(headerEnd) };
}

/**
 * Server-side header read: decode the envelope prefix and validate ONLY the two
 * fields the blind store is entitled to ({@link vaultServerHeaderSchema}). Throws
 * {@link VaultEnvelopeError} on a malformed envelope or an invalid header.
 */
export function readVaultServerHeader(bytes: Uint8Array): VaultServerHeader {
  const { header } = decodeVaultEnvelope(bytes);
  const parsed = vaultServerHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new VaultEnvelopeError('vault envelope header missing formatVersion/vaultVersion');
  }
  return parsed.data;
}
